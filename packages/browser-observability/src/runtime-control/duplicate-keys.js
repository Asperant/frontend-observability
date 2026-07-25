export function hasDuplicateObjectKeys(jsonText) {
  if (typeof jsonText !== "string") return false;
  const stack = [];
  let index = 0;
  let expectingObjectKey = false;

  while (index < jsonText.length) {
    const char = jsonText[index];
    if (char === '"') {
      const { value, end } = readJsonString(jsonText, index);
      if (expectingObjectKey && stack.length > 0) {
        const current = stack.at(-1);
        if (current.has(value)) return true;
        current.add(value);
        expectingObjectKey = false;
      }
      index = end + 1;
      continue;
    }
    if (char === "{") {
      stack.push(new Set());
      expectingObjectKey = true;
    } else if (char === "}") {
      stack.pop();
      expectingObjectKey = false;
    } else if (char === ",") {
      if (stack.length > 0) expectingObjectKey = true;
    } else if (char === ":") {
      expectingObjectKey = false;
    }
    index += 1;
  }
  return false;
}

function readJsonString(text, start) {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      value += char;
      index += 2;
      continue;
    }
    if (char === '"') return { value, end: index };
    value += char;
    index += 1;
  }
  return { value, end: index };
}
