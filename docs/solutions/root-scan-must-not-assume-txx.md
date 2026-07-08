# Root Scan Must Not Assume Txx

The image root scanner must follow the current dataset contract, not legacy folder naming assumptions. A valid root contains child folders sorted by folder name; each usable child folder has `image/` and `mask/` directories, and `image/` contains a `.tif` or `.tiff` file. Do not require folder names to match `name_Txx` unless the user explicitly restores that requirement.
