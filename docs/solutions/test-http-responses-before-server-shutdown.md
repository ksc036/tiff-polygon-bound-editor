# Buffer Test HTTP Responses Before Server Shutdown

When a test helper starts an ephemeral HTTP server and returns a `fetch()`
response, consume the response body before closing the server. `fetch()` can
resolve after receiving headers while the body is still in flight, so closing
the server in `finally` can intermittently produce `UND_ERR_SOCKET: other side
closed` during a later `response.json()` call, especially under parallel test
load.

Buffer the body and return a reconstructed response:

```js
const response = await fetch(url, options);
const body = await response.arrayBuffer();

return new Response(body.byteLength > 0 ? body : null, {
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
});
```

This makes the response independent of the temporary server before teardown.
Verify the change with the focused server test file and the full parallel test
suite; a focused pass alone may not reproduce the race.
