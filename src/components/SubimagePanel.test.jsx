/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import SubimagePanel from "./SubimagePanel.jsx";

const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };

function handlers() {
  return {
    onSetCrop: vi.fn(),
    onCreateMissing: vi.fn(),
    onSave: vi.fn(),
    onStartReplace: vi.fn(),
    onApplyReplace: vi.fn(),
    onCancelReplace: vi.fn(),
  };
}

function renderPanel(overrides = {}) {
  const callbacks = handlers();
  const props = {
    activeImageName: "T01",
    templateOwnerName: "T01",
    isTemplateOwner: true,
    hasSubimage: false,
    crop,
    dirty: true,
    mode: "idle",
    busy: null,
    error: "",
    result: null,
    canCreateMissing: true,
    canSetCrop: true,
    canSave: false,
    canReplace: false,
    ...callbacks,
    ...overrides,
  };

  return { callbacks, ...render(<SubimagePanel {...props} />) };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubimagePanel", () => {
  test("shows the template identity, read-only crop fields, and available initial actions", () => {
    const { callbacks } = renderPanel();

    expect(screen.getByRole("heading", { name: "Subimage" })).toBeInTheDocument();
    expect(screen.getByText("T01")).toBeInTheDocument();
    expect(screen.getByText("x 20")).toBeInTheDocument();
    expect(screen.getByText("40 x 30 px")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create all subimages" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save subimage" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Set crop" }));
    expect(callbacks.onSetCrop).toHaveBeenCalledTimes(1);
  });

  test("identifies a later image and its separate template owner", () => {
    const { callbacks } = renderPanel({
      activeImageName: "T02",
      isTemplateOwner: false,
      canCreateMissing: false,
      canSetCrop: false,
    });

    expect(screen.getByText("T02")).toBeInTheDocument();
    expect(screen.getByText("Template: T01")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set crop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create all subimages" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Set crop" }));
    expect(callbacks.onSetCrop).not.toHaveBeenCalled();
  });

  test("enables saving a dirty locked crop", () => {
    renderPanel({ hasSubimage: true, canSave: true });

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save subimage" })).toBeEnabled();
  });

  test("announces the active crop selection mode", () => {
    renderPanel({ mode: "select-initial" });

    expect(screen.getByRole("status")).toHaveTextContent("Select the initial crop");
  });

  test("offers replacement confirmation actions only in confirmation mode", () => {
    renderPanel({ mode: "confirm-replacement", canReplace: true });

    expect(screen.getByRole("button", { name: "Apply replacement" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel replacement" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Replace all subimages" })).not.toBeInTheDocument();
  });

  test("disables every action and announces the busy operation", () => {
    renderPanel({ busy: "replace-all", canSave: true, canReplace: true });

    expect(screen.getByText("Replacing all subimages")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).not.toHaveLength(0);
    screen.getAllByRole("button").forEach((button) => expect(button).toBeDisabled());
  });

  test("reports the current error and renders partial batch entries in source order", () => {
    renderPanel({
      error: "Subimage batch preflight failed.",
      result: {
        operation: "replace-all",
        status: "partial",
        code: "PARTIAL_BATCH",
        created: ["T03"],
        preserved: ["T04"],
        replaced: ["T01", "T05"],
        failed: [
          { imageFolder: "T02", code: "WRITE_FAILED", message: "Unable to save subimage." },
          { imageFolder: "T06", code: "WRITE_FAILED", message: "Unable to save subimage." },
        ],
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Subimage batch preflight failed.");
    expect(screen.getByText("Created (1): T03")).toBeInTheDocument();
    expect(screen.getByText("Preserved (1): T04")).toBeInTheDocument();
    expect(screen.getByText("Replaced (2): T01, T05")).toBeInTheDocument();
    expect(screen.getByText("Failed (2): T02 - Unable to save subimage., T06 - Unable to save subimage.")).toBeInTheDocument();
    expect(screen.getAllByTestId("subimage-batch-item").map((item) => item.textContent)).toEqual([
      "Created (1): T03",
      "Preserved (1): T04",
      "Replaced (2): T01, T05",
      "Failed (2): T02 - Unable to save subimage., T06 - Unable to save subimage.",
    ]);
  });
});
