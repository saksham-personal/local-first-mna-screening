const stopWords = new Set('a an and are as at be business by central company companies directly for from include includes is it must not of only or product products pure sold that the their this to used whose with workflow workflows exclude excluded'.split(' '));
const deferredAttribute = /\b(revenue|ebitda|employees?|headcount|turnover|ownership|owned|geograph\w*|headquarters|hq|located|based|countries|country|region|us|usa|united states|north america|europe|naics|sic|size|financial\w*)\b/i;

/** A bounded local drafting aid. The analyst approves the full definition;
 * only explicit core-business exclusion clauses become keyword exclusions. */
export function discoveryDefinition(definition) {
  const marker = /\b(?:exclude(?:s|d)?|excluding|except|do\s+not\s+include)\b/i.exec(definition);
  const positive = (marker ? definition.slice(0, marker.index) : definition).trim().replace(/[.;,:]+$/, '').trim();
  if (!positive) throw new Error('Add a core business description before searching.');
  const exclusions = marker ? [...new Set(definition.slice(marker.index + marker[0].length)
    .split(/[,;\n]|\s+or\s+/i)
    .map(text => text.trim().replace(/^and\s+/i, '').replace(/[.!]+$/, '').trim())
    .filter(text => text && !deferredAttribute.test(text)))] : [];
  if (exclusions.length > 100 || exclusions.some(text => text.length > 500)) throw new Error('Shorten the core-business exclusion list before searching.');
  return { positive, exclusions };
}

export function qualitativeQuery(definition) {
  const { positive } = discoveryDefinition(definition);
  const words = [...new Set((positive.match(/[a-zA-Z][a-zA-Z0-9-]{2,}/g) ?? [])
    .map(word => word.toLowerCase()).filter(word => !stopWords.has(word)))];
  if (!words.length) throw new Error('Add specific products or services before searching.');
  return words.slice(0, 12).join(' ');
}

export function discoveryQueries(definition) {
  const { positive } = discoveryDefinition(definition);
  // Natural-language negation must never become a Boolean exclusion bypass.
  const safeSentence = !/\bNOT\b|(?:^|[\s(])[-−]/i.test(positive);
  return [...new Set([...(safeSentence ? [positive] : []), qualitativeQuery(positive)])];
}
