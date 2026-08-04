/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import SubimageOverlay from "./SubimageOverlay.jsx";

describe("SubimageOverlay", () => {
  test("renders an even-odd outside shade and exact crop outline", () => {
    render(<SubimageOverlay crop={{ x: 20, y: 10, width: 40, height: 30 }} imageWidth={100} imageHeight={75} />);

    expect(screen.getByLabelText("Subimage crop overlay")).toHaveAttribute("viewBox", "0 0 100 75");
    expect(screen.getByTestId("subimage-outside-shade")).toHaveAttribute("fill-rule", "evenodd");
    expect(screen.getByLabelText("Crop x 20 y 10 width 40 height 30")).toHaveAttribute("width", "40");
  });

  test("renders no overlay without a valid crop", () => {
    const { container } = render(<SubimageOverlay crop={null} imageWidth={100} imageHeight={75} />);

    expect(container).toBeEmptyDOMElement();
  });
});
