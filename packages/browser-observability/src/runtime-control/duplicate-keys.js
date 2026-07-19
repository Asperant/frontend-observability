// JSON.parse silently keeps the *last* value of a duplicate object key,
// which would let a proxy/CDN response-splitting bug or a compromised
// control endpoint smuggle a second, contradictory `killSwitch` (or any
// other field) past a naive parse. This walks the raw response text with a
// small hand-rolled structural scanner — independent of JSON.parse — and
// reports true the moment any single object literal, at any nesting depth,
// repeats a key. Malformed JSON is deliberately not this function's
// concern: on any tokenizing/structural failure it fails safe by returning
// false (no duplicate found) and leaves rejecting truly malformed input to
// the normal JSON.parse call that always runs alongside it.
export function hasDuplicateObjectKeys(text) {
  if (typeof text !== "string") return false;
  try {
    return scan(text);
  } catch {
    return false;
  }
}

const STRUCTURAL = new Set(["{", "}", "[", "]", ":", ","]);

function scan(text) {
  const tokens = tokenize(text);
  const stack = [];
  let expect = "value"; // for the current (implicit root) context
  let duplicateFound = false;

  const valueConsumed = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    expect = top.type === "object" ? "comma-or-close-object" : "comma-or-close-array";
  };

  for (const token of tokens) {
    if (token.type === "punct" && token.value === "{") {
      stack.push({ type: "object", keys: new Set() });
      expect = "key-or-close-object";
      continue;
    }
    if (token.type === "punct" && token.value === "[") {
      stack.push({ type: "array" });
      expect = "value-or-close-array";
      continue;
    }
    if (token.type === "punct" && token.value === "}") {
      if (stack.pop()?.type !== "object") throw new Error("malformed");
      valueConsumed();
      continue;
    }
    if (token.type === "punct" && token.value === "]") {
      if (stack.pop()?.type !== "array") throw new Error("malformed");
      valueConsumed();
      continue;
    }
    if (token.type === "punct" && token.value === ":") {
      if (expect !== "colon") throw new Error("malformed");
      expect = "value";
      continue;
    }
    if (token.type === "punct" && token.value === ",") {
      const top = stack[stack.length - 1];
      if (!top) throw new Error("malformed");
      expect = top.type === "object" ? "key-or-close-object" : "value-or-close-array";
      continue;
    }

    // A string/number/literal token.
    const top = stack[stack.length - 1];
    if ((expect === "key-or-close-object" || expect === "key") && top?.type === "object") {
      if (token.type !== "string") throw new Error("malformed");
      if (top.keys.has(token.value)) duplicateFound = true;
      top.keys.add(token.value);
      expect = "colon";
      continue;
    }
    if (expect === "value" || expect === "value-or-close-array") {
      valueConsumed();
      continue;
    }
    throw new Error("malformed");
  }

  return duplicateFound;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (STRUCTURAL.has(ch)) {
      tokens.push({ type: "punct", value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const { value, next } = readString(text, i);
      tokens.push({ type: "string", value });
      i = next;
      continue;
    }
    // Number / true / false / null: consume until the next whitespace or
    // structural character. The exact value is never needed here.
    let j = i;
    while (j < len && !STRUCTURAL.has(text[j]) && !/\s/.test(text[j])) j += 1;
    if (j === i) throw new Error("malformed");
    tokens.push({ type: "literal", value: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

function readString(text, start) {
  let i = start + 1;
  let value = "";
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === '"') {
      return { value, next: i + 1 };
    }
    if (ch === "\\") {
      if (i + 1 >= len) throw new Error("malformed");
      value += ch + text[i + 1];
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  throw new Error("malformed");
}
