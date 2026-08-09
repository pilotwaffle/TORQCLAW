if (process.env.NODE_ENV !== 'test') {
  throw new Error('collab gateway test preload requires NODE_ENV=test');
}
const raw = process.env.TORQCLAW_COLLAB_TEST_PEPPER;
if (!raw) {
  throw new Error('collab gateway test preload requires TORQCLAW_COLLAB_TEST_PEPPER');
}
const pepper = Buffer.from(raw, 'base64');
if (pepper.length !== 32) {
  throw new Error('collab gateway test pepper must decode to exactly 32 bytes');
}
const [{ setCollabSecretStoreForTest }, { InMemorySecretStore }] = await Promise.all([
  import(new URL('../../packages/gateway/dist/collabIdentity.js', import.meta.url)),
  import(new URL('../../packages/collab/dist/index.js', import.meta.url)),
]);
const store = new InMemorySecretStore();
store.set('TORQCLAW/principal-pepper', pepper);
setCollabSecretStoreForTest(store);
