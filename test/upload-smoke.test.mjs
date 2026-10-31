import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readBoundedMultipart, getUploadSession, getUploadedClipId, putSignedUpload, BridgeError } from '../src/upload.ts';

it('extracts signed upload session information', () => {
  assert.deepEqual(getUploadSession({ data: { session_id:'sid-1', clip_id: 'cid-1', upload_url: 'https://upload.example.com/' } }), {
    sessionId:'sid-1', clipId:'cid-1', uploadUrl:'https://upload.example.com/'
  });
  assert.equal(getUploadedClipId({ id: 'clip-2' }), 'clip-2');
});

it('extracts upload metadata from mixed-media MCP envelopes', () => {
  const media = { type: 'resource_link', uri: 'https://files.example.net/audio.wav', name: 'audio.wav' };
  const session = { data: { session_id: 'media-session', clip_id: 'source-clip', upload_url: 'https://upload.example.net/' } };
  const completed = { data: { clip: { id: 'completed-clip' } } };
  for (const payload of [session, completed]) {
    const content = [{ type: 'text', text: JSON.stringify(payload) }, media];
    for (const result of [{ structuredContent: payload, content }, { content }]) {
      if (payload === session) {
        assert.deepEqual(getUploadSession(result), { sessionId: 'media-session', clipId: 'source-clip', uploadUrl: 'https://upload.example.net/' });
      } else {
        assert.equal(getUploadedClipId(result), 'completed-clip');
      }
    }
  }
});

it('does not select an arbitrary upload payload from ambiguous JSON blocks', () => {
  const content = [
    { type: 'text', text: '{"id":"first","upload_url":"https://upload.example.net/first"}' },
    { type: 'text', text: '{"id":"second","upload_url":"https://upload.example.net/second"}' }
  ];
  assert.throws(() => getUploadSession({ content }), BridgeError);
  assert.equal(getUploadedClipId({ content }), undefined);
});

it('parses bounded multipart without an external dependency', async () => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([4,5,6])], 'test.wav', { type: 'audio/wav' }));
  form.set('title', 'Loop');
  const req = new Request('http://localhost/api/uploads/file', { method: 'POST', body: form });
  const parsed = await readBoundedMultipart(req, 4096);
  const file = parsed.get('file');
  assert.ok(file instanceof File);
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [4,5,6]);
  assert.equal(parsed.get('title'), 'Loop');
});

it('rejects oversized multipart and unsafe upload URLs', async () => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(2000)], 'big.wav'));
  const req = new Request('http://localhost/api/uploads/file', { method: 'POST', body: form });
  await assert.rejects(() => readBoundedMultipart(req, 1024), (error) => error instanceof BridgeError && error.status === 413);
  await assert.rejects(() => putSignedUpload('http://127.0.0.1/local', new Uint8Array([1])), BridgeError);
});

it('PUTs raw bytes to the signed URL (mocked fetch, no network access)', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), method: init.method, bytes: Array.from(init.body), redirect: init.redirect });
      return new Response(null, { status: 204 });
    };
    await putSignedUpload('https://upload.example.net/signed', new Uint8Array([0, 8, 255]));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(sent, [{
    url: 'https://upload.example.net/signed', method: 'PUT', bytes: [0, 8, 255], redirect: 'error'
  }]);
});
