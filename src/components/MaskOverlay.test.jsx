/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import MaskOverlay from "./MaskOverlay.jsx";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bitmap(values = [0, 255], width = 2, height = 1) {
  return {
    width,
    height,
    pixels: Uint8ClampedArray.from(values.flatMap((value) => [value, value, value, 255])),
    close: vi.fn(),
  };
}

function pngResponse() {
  return { ok: true, status: 200, blob: vi.fn(async () => new Blob(["png"], { type: "image/png" })) };
}

const props = { imageId: "scan-a", width: 2, height: 1 };
const redRight = [0, 0, 0, 0, 255, 0, 0, 255];
const redLeft = [255, 0, 0, 255, 0, 0, 0, 0];
const transparent = [0, 0, 0, 0, 0, 0, 0, 0];

describe("MaskOverlay", () => {
  let contexts;
  let decoded;

  function contextFor(canvas = screen.getByLabelText("Mask overlay")) {
    return canvas.getContext("2d");
  }

  function pixels(canvas = screen.getByLabelText("Mask overlay")) {
    return Array.from(contextFor(canvas).getImageData(0, 0, canvas.width, canvas.height).data);
  }

  beforeEach(() => {
    contexts = new WeakMap();
    decoded = [];
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse()));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      const image = bitmap();
      decoded.push(image);
      return image;
    }));
    // jsdom has no canvas rasterizer; retain actual pixel buffers across canvas calls.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
      if (!contexts.has(this)) {
        let buffer = new Uint8ClampedArray(this.width * this.height * 4);
        contexts.set(this, {
          clearRect: vi.fn(() => buffer.fill(0)),
          drawImage: vi.fn((image) => { buffer = image.pixels.slice(); }),
          getImageData: vi.fn(() => ({ data: buffer.slice(), width: this.width, height: this.height })),
          putImageData: vi.fn((image) => { buffer = image.data.slice(); }),
          globalAlpha: 1,
          imageSmoothingEnabled: true,
        });
      }
      return contexts.get(this);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("draws exact opaque red foreground and transparent background with opacity applied only by CSS", async () => {
    const image = bitmap([0, 255, 255, 255], 2, 2);
    image.pixels[11] = 0;
    image.pixels[15] = 80;
    createImageBitmap.mockResolvedValueOnce(image);
    render(<MaskOverlay {...props} imageId="scan /?#" height={2} />);

    const canvas = screen.getByLabelText("Mask overlay");
    await waitFor(() => expect(pixels()).toEqual([
      0, 0, 0, 0, 255, 0, 0, 255,
      0, 0, 0, 0, 255, 0, 0, 255,
    ]));
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveClass("layer-image", "original-mask-overlay");
    expect(canvas).toHaveAttribute("width", "2");
    expect(canvas).toHaveAttribute("height", "2");
    expect(canvas).toHaveStyle({ opacity: "0.55" });
    expect(fetch).toHaveBeenCalledWith("/api/images/scan%20%2F%3F%23/mask-preview", {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob));
    expect(contextFor().drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(image.close).toHaveBeenCalledTimes(1);
  });

  test("changes opacity without fetching, decoding, or repainting pixels", async () => {
    const { rerender } = render(<MaskOverlay {...props} opacity={0.55} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));

    rerender(<MaskOverlay {...props} opacity={0} />);
    expect(screen.getByLabelText("Mask overlay")).toHaveStyle({ opacity: "0" });
    rerender(<MaskOverlay {...props} opacity={0.9} />);
    expect(screen.getByLabelText("Mask overlay")).toHaveStyle({ opacity: "0.9" });
    expect(pixels()).toEqual(redRight);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(contextFor().putImageData).toHaveBeenCalledTimes(1);
  });

  test("clears a previous mask synchronously when switching images of the same size", async () => {
    const nextFetch = deferred();
    const pixelsBeforePaint = [];
    function Frame({ imageId }) {
      React.useLayoutEffect(() => {
        pixelsBeforePaint.push(pixels());
      }, [imageId]);
      return <MaskOverlay {...props} imageId={imageId} />;
    }
    const { rerender } = render(<Frame imageId="scan-a" />);
    await waitFor(() => expect(pixels()).toEqual(redRight));
    const signal = fetch.mock.calls[0][1].signal;
    fetch.mockReturnValueOnce(nextFetch.promise);
    createImageBitmap.mockResolvedValueOnce(bitmap([255, 0]));

    rerender(<Frame imageId="scan-b" />);
    expect(pixels()).toEqual(transparent);
    expect(pixelsBeforePaint.at(-1)).toEqual(transparent);
    expect(signal.aborted).toBe(true);

    await act(async () => nextFetch.resolve(pngResponse()));
    expect(pixels()).toEqual(redLeft);
  });

  test("ignores out-of-order fetch responses even when fetch does not honor abort", async () => {
    const oldFetch = deferred();
    fetch.mockReturnValueOnce(oldFetch.promise);
    const { rerender } = render(<MaskOverlay {...props} />);
    rerender(<MaskOverlay {...props} imageId="scan-b" />);
    await waitFor(() => expect(pixels()).toEqual(redRight));
    const oldResponse = pngResponse();

    await act(async () => oldFetch.resolve(oldResponse));
    expect(pixels()).toEqual(redRight);
    expect(oldResponse.blob).not.toHaveBeenCalled();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  test("does not decode a stale response body that finishes after an image switch", async () => {
    const oldBody = deferred();
    const oldResponse = { ...pngResponse(), blob: vi.fn(() => oldBody.promise) };
    fetch.mockResolvedValueOnce(oldResponse);
    const { rerender } = render(<MaskOverlay {...props} />);
    await waitFor(() => expect(oldResponse.blob).toHaveBeenCalled());
    rerender(<MaskOverlay {...props} imageId="scan-b" />);
    await waitFor(() => expect(pixels()).toEqual(redRight));

    await act(async () => oldBody.resolve(new Blob(["old png"])));
    expect(pixels()).toEqual(redRight);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  test("closes a stale decoded bitmap without overwriting the new image", async () => {
    const oldDecode = deferred();
    const oldImage = bitmap([255, 0]);
    const onError = vi.fn();
    createImageBitmap.mockReturnValueOnce(oldDecode.promise);
    const { rerender } = render(<MaskOverlay {...props} onError={onError} />);
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
    rerender(<MaskOverlay {...props} imageId="scan-b" onError={onError} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));

    await act(async () => oldDecode.resolve(oldImage));
    expect(pixels()).toEqual(redRight);
    expect(contextFor().putImageData).toHaveBeenCalledTimes(1);
    expect(oldImage.close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test.each(["fetch", "decode"])("ignores a stale %s rejection without reporting an error or clearing the new mask", async (stage) => {
    const oldOperation = deferred();
    const onError = vi.fn();
    if (stage === "fetch") fetch.mockReturnValueOnce(oldOperation.promise);
    else createImageBitmap.mockReturnValueOnce(oldOperation.promise);
    const { rerender } = render(<MaskOverlay {...props} onError={onError} />);
    if (stage === "decode") await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
    rerender(<MaskOverlay {...props} imageId="scan-b" onError={onError} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));

    await act(async () => oldOperation.reject(new Error("Old operation failed.")));
    expect(pixels()).toEqual(redRight);
    expect(onError).not.toHaveBeenCalled();
  });

  test("reloads a changed revision and clears old pixels while loading", async () => {
    const nextFetch = deferred();
    const { rerender } = render(<MaskOverlay {...props} revision={1} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));
    fetch.mockReturnValueOnce(nextFetch.promise);
    createImageBitmap.mockResolvedValueOnce(bitmap([255, 0]));

    rerender(<MaskOverlay {...props} revision={2} />);
    expect(pixels()).toEqual(transparent);
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => nextFetch.resolve(pngResponse()));
    expect(pixels()).toEqual(redLeft);
  });

  test("reloads when the supplied image dimensions change", async () => {
    const { rerender } = render(<MaskOverlay {...props} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));
    createImageBitmap.mockResolvedValueOnce(bitmap([255, 0], 1, 2));

    rerender(<MaskOverlay {...props} width={1} height={2} />);
    await waitFor(() => expect(pixels()).toEqual(redLeft));
    expect(screen.getByLabelText("Mask overlay")).toHaveAttribute("width", "1");
    expect(screen.getByLabelText("Mask overlay")).toHaveAttribute("height", "2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("survives StrictMode effect cleanup and remount without drawing the aborted request", async () => {
    const onError = vi.fn();
    render(<React.StrictMode><MaskOverlay {...props} onError={onError} /></React.StrictMode>);

    await waitFor(() => expect(pixels()).toEqual(redRight));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(decoded[0].close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test.each([[3, 1], [2, 2]])("rejects decoded dimensions %i x %i instead of stretching the mask", async (width, height) => {
    const image = bitmap(Array(width * height).fill(255), width, height);
    createImageBitmap.mockResolvedValueOnce(image);
    const onError = vi.fn();
    render(<MaskOverlay {...props} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/dimensions.*match/i)));
    expect(pixels()).toEqual(transparent);
    expect(contextFor().drawImage).not.toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledTimes(1);
  });

  test.each(["network", "missing mask", "non-JSON HTTP error", "decode", "response body", "pixel read"])("reports a %s error with no stale overlay", async (stage) => {
    const onError = vi.fn();
    const { rerender } = render(<MaskOverlay {...props} onError={onError} />);
    await waitFor(() => expect(pixels()).toEqual(redRight));
    const failure = new Error(`Unable to load mask: ${stage}.`);
    if (stage === "network") fetch.mockRejectedValueOnce(failure);
    if (stage === "missing mask") fetch.mockResolvedValueOnce({
      ok: false, status: 409, json: async () => ({ error: "Mask image is required before analysis." }),
    });
    if (stage === "non-JSON HTTP error") fetch.mockResolvedValueOnce({
      ok: false, status: 503, json: async () => { throw new Error("Not JSON"); },
    });
    if (stage === "decode") createImageBitmap.mockRejectedValueOnce(failure);
    if (stage === "response body") fetch.mockResolvedValueOnce({
      ...pngResponse(), blob: async () => { throw failure; },
    });
    if (stage === "pixel read") contextFor().getImageData.mockImplementationOnce(() => { throw failure; });

    rerender(<MaskOverlay {...props} revision={1} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const message = onError.mock.calls[0][0];
    expect(typeof message).toBe("string");
    expect(message).toMatch(stage === "missing mask" ? /mask image is required/i : stage === "non-JSON HTTP error" ? /503/ : new RegExp(stage));
    expect(pixels()).toEqual(transparent);
    decoded.forEach((image) => expect(image.close).toHaveBeenCalledTimes(1));
  });

  test("reports unavailable canvas rendering without fetching", async () => {
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
    const onError = vi.fn();
    render(<MaskOverlay {...props} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/canvas/i)));
    expect(fetch).not.toHaveBeenCalled();
  });

  test("handles errors when no onError callback is supplied", async () => {
    fetch.mockRejectedValueOnce(new Error("Network failed"));
    await act(async () => render(<MaskOverlay {...props} />));
    expect(pixels()).toEqual(transparent);
  });

  test("uses the latest onError callback without restarting an in-flight request", async () => {
    const request = deferred();
    fetch.mockReturnValueOnce(request.promise);
    const oldError = vi.fn();
    const newError = vi.fn();
    const { rerender } = render(<MaskOverlay {...props} onError={oldError} />);
    rerender(<MaskOverlay {...props} onError={newError} />);
    await act(async () => request.reject(new Error("Network failed")));

    expect(oldError).not.toHaveBeenCalled();
    expect(newError).toHaveBeenCalledWith("Network failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("aborts and clears on unmount without decoding late fetch results", async () => {
    const request = deferred();
    fetch.mockReturnValueOnce(request.promise);
    const onError = vi.fn();
    const { unmount } = render(<MaskOverlay {...props} onError={onError} />);
    const signal = fetch.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => request.resolve(pngResponse()));
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("closes a bitmap whose decode finishes after unmount without drawing it", async () => {
    const decoding = deferred();
    const image = bitmap();
    createImageBitmap.mockReturnValueOnce(decoding.promise);
    const onError = vi.fn();
    const { unmount } = render(<MaskOverlay {...props} onError={onError} />);
    const canvas = screen.getByLabelText("Mask overlay");
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => decoding.resolve(image));

    expect(image.close).toHaveBeenCalledTimes(1);
    expect(contextFor(canvas).drawImage).not.toHaveBeenCalled();
    expect(pixels(canvas)).toEqual(transparent);
    expect(onError).not.toHaveBeenCalled();
  });

  test("clears a painted canvas on unmount", async () => {
    const { unmount } = render(<MaskOverlay {...props} />);
    const canvas = screen.getByLabelText("Mask overlay");
    await waitFor(() => expect(pixels()).toEqual(redRight));
    unmount();
    expect(pixels(canvas)).toEqual(transparent);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(decoded[0].close).toHaveBeenCalledTimes(1);
  });
});
