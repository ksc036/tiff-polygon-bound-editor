# Probability Map Inference API

This contract connects the local mask-setting application to the U-Net++ model
server. The local application reads original TIFF files but never changes them.
It uploads each source file sequentially and stores only the returned
probability map in the dataset's `probability-maps` folder.

## Base URL

The application user enters a server base URL, for example:

```text
http://192.168.0.15:8000
```

The application calls this fixed endpoint:

```text
POST {base-url}/v1/inference/probability-map
```

The base URL must not include `/v1/inference/probability-map` itself.

## Request

```http
POST /v1/inference/probability-map HTTP/1.1
Accept: application/x-npy
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="file"; filename="sample.tif"
Content-Type: image/tiff

<original TIFF bytes>
--boundary--
```

| Field | Required | Type | Rule |
| --- | --- | --- | --- |
| `file` | Yes | multipart file | Original `.tif` or `.tiff` file, sent unchanged. |

No base64 encoding, image resizing parameters, threshold values, or ROI data are
sent to the model server. The model server may resize internally for U-Net++, but
must resize its output back to the original TIFF dimensions before responding.

## Successful Response

```http
HTTP/1.1 200 OK
Content-Type: application/x-npy

<NumPy .npy bytes>
```

The body must be exactly one NumPy `.npy` array with this contract:

| Property | Required value |
| --- | --- |
| NumPy format | Version 1.0 or 2.0 `.npy` |
| dtype | Little-endian `float32` (`<f4`) |
| array order | C-order (`fortran_order: False`) |
| shape | `(original_height, original_width)` |
| values | Finite normalized collagen probabilities, every value `0.0 <= p <= 1.0` |
| channels | One probability value per source pixel; no RGB/RGBA/channel axis |

The model output semantics are:

```text
0.0 = certainly background / not collagen
1.0 = certainly collagen
```

The local app initially thresholds this array at `0.5`, then lets the user
inspect and change the threshold. The server must not apply a binary threshold.

## Python/FastAPI Reference

```python
from io import BytesIO

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI()

@app.post("/v1/inference/probability-map")
async def probability_map(file: UploadFile = File(...)):
    if file.content_type not in {"image/tiff", "image/x-tiff", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Expected a TIFF file.")

    source_bytes = await file.read()
    original_image = read_tiff(source_bytes)  # Implement with tifffile/Pillow/etc.
    original_height, original_width = original_image.shape[:2]

    model_input = preprocess_for_unetplusplus(original_image)
    model_probability = run_unetplusplus(model_input)  # values should represent collagen probability
    probability = resize_to_shape(model_probability, (original_height, original_width))
    probability = np.asarray(probability, dtype="<f4")

    if probability.shape != (original_height, original_width):
        raise HTTPException(status_code=500, detail="Model output has wrong dimensions.")
    if not np.isfinite(probability).all() or probability.min() < 0 or probability.max() > 1:
        raise HTTPException(status_code=500, detail="Model output is not a normalized probability map.")

    output = BytesIO()
    np.save(output, probability, allow_pickle=False)
    return Response(content=output.getvalue(), media_type="application/x-npy")
```

`read_tiff`, preprocessing, and model inference are server implementation
details. The output shape and normalized `float32` data contract are not.

## Error Response

All failures return JSON, never a partial `.npy` file:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/json

{
  "error": "The TIFF could not be decoded.",
  "code": "INVALID_TIFF"
}
```

| Status | Recommended code | Meaning |
| --- | --- | --- |
| `400` | `MISSING_FILE` | The multipart `file` field is absent. |
| `413` | `FILE_TOO_LARGE` | The uploaded TIFF exceeds the model server limit. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | The uploaded file is not accepted as TIFF. |
| `422` | `INVALID_TIFF` | TIFF decoding or model input preparation failed. |
| `500` | `MODEL_FAILURE` | Inference failed or output violated the probability-map contract. |

The local application shows a safe failure message for the corresponding image,
continues with the next queued TIFF, and never stores an error body as a map.

## Verification

```bash
curl --fail-with-body \
  -X POST "http://localhost:8000/v1/inference/probability-map" \
  -H "Accept: application/x-npy" \
  -F "file=@sample.tif;type=image/tiff" \
  --output sample.probability.npy
```

```python
import numpy as np

probability = np.load("sample.probability.npy", allow_pickle=False)
assert probability.dtype == np.dtype("<f4")
assert probability.flags.c_contiguous
assert probability.shape == (original_height, original_width)
assert np.isfinite(probability).all()
assert 0.0 <= probability.min() <= probability.max() <= 1.0
```

## Dataset Output Names

The application uses the entire original filename, including its extension, to
avoid collisions such as `sample.tif` and `sample.tiff` in one `image` folder:

```text
<timestamp>/probability-maps/sample.tif.probability.npy
<timestamp>/probability-maps/sample.tif.mask-setting.json
<timestamp>/mask/sample.tif.png
```
