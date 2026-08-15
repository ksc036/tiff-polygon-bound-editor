# Inference Must Scan Every TIFF Per Timestamp

The existing polygon editor models one timestamp folder as one image and selects
the first TIFF in its `image/` directory. The inference mask workflow has a
different unit of work: every TIFF inside every timestamp's `image/` directory
needs its own probability map, threshold, status, and generated mask. Do not
reuse the editor's image list for inference batches. Keep its behavior stable and
give inference an independent per-file scanner keyed by timestamp plus filename.
