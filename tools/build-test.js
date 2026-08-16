/* Tests the Netlify build against the REAL file, not a paraphrase of it.

   The bug this exists to prevent: apiConfigured() used to compare CONFIG.API
   against a named placeholder constant, but sed substitutes the token
   everywhere in the file — including in the line defining that constant. Both
   sides became the real URL, so the check reported "not configured" exactly
   when injection had succeeded. A hand-written test of the same logic passed,
   because it never ran the actual substitution.

   So: run inject-config.sh for real, then evaluate what comes out.

       node tools/build-test.js                                            */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REL = "Deploy Front End HTML/index.html";
const REAL_URL = "https://script.google.com/macros/s/AKfycbxTEST123456789/exec";

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: " + detail : "")); }
};

/** Copy the repo to a temp dir and run the build there. */
function build(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickem-build-"));
  for (const rel of [REL, "tools/inject-config.sh"]) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  try {
    execFileSync("bash", ["tools/inject-config.sh"], {
      cwd: dir, env: { ...process.env, ...env }, stdio: "pipe"
    });
    return { ok: true, dir, html: fs.readFileSync(path.join(dir, REL), "utf8") };
  } catch (e) {
    return { ok: false, dir, stderr: String(e.stderr || "") };
  }
}

/** Pull CONFIG.API + apiConfigured() out of a built file and actually run them. */
function evaluate(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const configSrc = script.match(/const CONFIG = \{[\s\S]*?\n\};/)[0];
  const fnSrc = script.match(/function apiConfigured\(\) \{[\s\S]*?\n\}/)[0];
  return new Function(
    "localStorage",
    configSrc + "\n" + fnSrc + "\nreturn { api: CONFIG.API, configured: apiConfigured() };"
  )({ getItem: () => null });
}

console.log("\nbuild refuses bad input");
{
  const r = build({ APPS_SCRIPT_URL: "" });
  ok(!r.ok, "empty variable fails the build");
  ok(/APPS_SCRIPT_URL is not set/.test(r.stderr), "and says which variable", r.stderr.split("\n")[0]);

  const bad = build({ APPS_SCRIPT_URL: "http://example.com/notexec" });
  ok(!bad.ok, "a URL not ending in /exec fails");
}

console.log("\nbuild output is actually usable");
{
  const r = build({ APPS_SCRIPT_URL: REAL_URL });
  ok(r.ok, "valid URL builds");
  ok(!/__APPS_SCRIPT_URL__/.test(r.html), "no placeholder survives anywhere in the file");

  const got = evaluate(r.html);
  ok(got.api === REAL_URL, "CONFIG.API is the injected URL", got.api);
  // the regression: this was false even on a good build
  ok(got.configured === true, "apiConfigured() is TRUE after a good build", got.configured);
}

console.log("\nun-built file reports itself unconfigured");
{
  const html = fs.readFileSync(path.join(ROOT, REL), "utf8");
  const got = evaluate(html);
  ok(got.configured === false, "raw repo file is not configured", got.configured);
  ok(/__APPS_SCRIPT_URL__/.test(html), "and still carries the placeholder");
}

console.log("\nlocalStorage override wins");
{
  const html = fs.readFileSync(path.join(ROOT, REL), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const configSrc = script.match(/const CONFIG = \{[\s\S]*?\n\};/)[0];
  const fnSrc = script.match(/function apiConfigured\(\) \{[\s\S]*?\n\}/)[0];
  const got = new Function("localStorage",
    configSrc + "\n" + fnSrc + "\nreturn { api: CONFIG.API, configured: apiConfigured() };"
  )({ getItem: (k) => (k === "pg_api" ? REAL_URL : null) });
  ok(got.configured === true, "override makes an un-built file work locally", got.configured);
  ok(got.api === REAL_URL, "and supplies the URL", got.api);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
