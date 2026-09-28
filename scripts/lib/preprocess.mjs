// Evaluates uBO-style `!#if` / `!#else` / `!#endif` preprocessor blocks.
// SilentBlock is an MV3 Chromium blocker without HTML filtering, so the environment
// below mirrors what uBO Lite reports for itself.

export const ENV = {
  ext_ublock: true,
  ext_ubol: true,
  ext_devbuild: false,
  env_chromium: true,
  env_mv3: true,
  env_edge: false,
  env_firefox: false,
  env_legacy: false,
  env_mobile: false,
  env_safari: false,
  cap_html_filtering: false,
  cap_ipaddress: false,
  cap_user_stylesheet: true,
  false: false,
  true: true,
};

// Tiny recursive-descent evaluator for expressions like `env_chromium && !(cap_html_filtering || false)`.
export function evaluate(expr, env = ENV) {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[A-Za-z0-9_]+/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function primary() {
    const t = next();
    if (t === '!') return !primary();
    if (t === '(') { const v = or(); next(); return v; }
    return t in env ? Boolean(env[t]) : false;
  }
  function and() { let v = primary(); while (peek() === '&&') { next(); const r = primary(); v = v && r; } return v; }
  function or() { let v = and(); while (peek() === '||') { next(); const r = and(); v = v || r; } return v; }
  return tokens.length ? or() : false;
}

// Returns the lines that survive preprocessing. `!#include` is dropped (we only use
// pre-expanded .min lists), which is logged by the caller via the returned stats.
export function preprocess(text, env = ENV) {
  const out = [];
  const stack = []; // each entry: { active: bool, parentActive: bool, taken: bool }
  let active = true;
  let includes = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!#if ')) {
      const cond = evaluate(line.slice(5));
      stack.push({ parentActive: active, taken: cond });
      active = active && cond;
      continue;
    }
    if (line === '!#else') {
      const top = stack[stack.length - 1];
      if (top) { active = top.parentActive && !top.taken; top.taken = true; }
      continue;
    }
    if (line === '!#endif') {
      const top = stack.pop();
      active = top ? top.parentActive : true;
      continue;
    }
    if (!active) continue;
    if (line.startsWith('!#include')) { includes++; continue; }
    out.push(line);
  }
  return { lines: out, includes };
}
