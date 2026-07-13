# Absolutely Positioned Legend Labels Need Reserved Layout Space

## Context

The Heat Map comparison legend placed its zero label below a 12px color scale with `position: absolute`. Because absolutely positioned children do not contribute to their parent's layout height, the following status line could move into the label's visual space.

## Rule

When a label extends outside a legend scale with absolute positioning, explicitly reserve enough space on the containing legend for the label and its offset. Keep the color scale height independent from that reserved space, and test both contracts so later styling does not reintroduce overlap or stretch the scale.
