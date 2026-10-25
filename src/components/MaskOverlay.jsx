import React, { useLayoutEffect, useRef } from "react";

export default function MaskOverlay({ imageId, width, height, opacity = 0.55, revision, onError }) {
  const canvasRef = useRef(null);
  const onErrorRef = useRef(onError);

  useLayoutEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const controller = new AbortController();
    const { signal } = controller;
    let context;

    async function loadMask() {
      try {
        context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas rendering is unavailable for the mask overlay.");

        // Clear before paint, including image switches that keep the same canvas size.
        context.clearRect(0, 0, width, height);
        const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/mask-preview`, {
          cache: "no-store",
          signal,
        });
        if (signal.aborted) return;
        if (!response.ok) {
          let message = `Unable to load mask overlay (status ${response.status}).`;
          try {
            const payload = await response.json();
            if (typeof payload?.error === "string" && payload.error) message = payload.error;
          } catch {
            // Non-JSON errors retain the HTTP status as a useful fallback.
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        if (signal.aborted) return;
        const bitmap = await createImageBitmap(blob);
        try {
          if (signal.aborted) return;
          if (bitmap.width !== width || bitmap.height !== height) {
            throw new Error("Mask dimensions do not match the original image dimensions.");
          }

          context.drawImage(bitmap, 0, 0);
          const imageData = context.getImageData(0, 0, width, height);
          const { data } = imageData;
          // The preview is binary grayscale: white is foreground, black is background.
          for (let offset = 0; offset < data.length; offset += 4) {
            const foreground = data[offset] > 0 && data[offset + 3] > 0;
            data[offset] = foreground ? 255 : 0;
            data[offset + 1] = 0;
            data[offset + 2] = 0;
            data[offset + 3] = foreground ? 255 : 0;
          }
          context.putImageData(imageData, 0, 0);
        } finally {
          bitmap.close();
        }
      } catch (error) {
        if (signal.aborted) return;
        context?.clearRect(0, 0, width, height);
        onErrorRef.current?.(error?.message || "Unable to load mask overlay.");
      }
    }

    void loadMask();
    return () => {
      controller.abort();
      context?.clearRect(0, 0, width, height);
    };
  }, [imageId, width, height, revision]);

  return (
    <canvas
      ref={canvasRef}
      className="layer-image original-mask-overlay"
      aria-label="Mask overlay"
      width={width}
      height={height}
      style={{ opacity }}
    />
  );
}
