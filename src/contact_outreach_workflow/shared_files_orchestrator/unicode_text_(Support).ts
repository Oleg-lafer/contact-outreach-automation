/** Replace invalid UTF-16 code units without changing valid surrogate pairs. */
export function replace_unpaired_surrogates(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2);
        index++;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value.charAt(index);
    }
  }
  return result;
}

/** JSON.stringify leaves lone surrogates escaped, which MySQL JSON rejects. */
export function stringify_mysql_safe_json(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "string" ? replace_unpaired_surrogates(nested) : nested,
  );
}
