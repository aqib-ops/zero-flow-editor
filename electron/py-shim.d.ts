/**
 * `scripts/transcribe.py` is imported as a string by self-setup.ts so it can be
 * written next to the runtime at install time (Python cannot read files out of
 * app.asar). The bundler loads `.py` files as text — see scripts/build-electron.mjs.
 */
declare module "*.py" {
  const content: string;
  export default content;
}
