# Pointer Alignment Uses Rendered Content Rect

Pointer-to-image coordinate mapping must use the rendered image content rectangle, not the outer tool/stage rectangle. Borders, padding, or absolute children inset from the stage can otherwise introduce visible drift between the cursor and vertex center.

CSS sizing must also preserve the image aspect ratio. A hard-coded viewport multiplier can stretch square TIFFs into rectangular stages, making visual inspection and pointer placement feel wrong even when the SVG viewBox uses correct image dimensions.
