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

/** Deterministic broad MID queries; the analyst's approved exclusions are the only NOT terms. */
export function midKeywordPlan(definition, exclusions = []) {
  const { positive } = discoveryDefinition(definition);
  const plannerStops = new Set([...stopWords, ...'build builds building develop develops developing provide provides providing offer offers offering support supports supporting help helps enable enables serving use uses'.split(' ')]);
  const offeringWords = new Set('software platform platforms saas cloud system systems solution solutions application applications technology technologies service services product products'.split(' '));
  const words = (positive.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word.toLowerCase());
  const domain = [...new Set(words.filter(word => word.length > 2 && !plannerStops.has(word) &&
    !offeringWords.has(word) && !deferredAttribute.test(word)))].slice(0, 12);
  const offerings = [...new Set(words.filter(word => offeringWords.has(word)))].slice(0, 8);
  const prefix = word => `${word.length > 4 && word.endsWith('s') && !word.endsWith('ss') && word !== 'saas' ? word.slice(0, -1) : word}*`;
  const keyword = (id, text) => ({ id, text, weight: 1, match: 'stem' });
  const domains = domain.map((word, i) => keyword(`d${i}`, prefix(word)));
  const products = offerings.map((word, i) => keyword(`p${i}`, prefix(word)));
  const approvedExclusions = [...new Set(exclusions)].filter(text => typeof text === 'string' && text.trim());
  if (domains.length + products.length + approvedExclusions.length > 50 || approvedExclusions.some(text => [...text].length > 80))
    throw new Error('The approved exclusions exceed the MID keyword query limits.');
  const negatives = approvedExclusions.map((text, i) => keyword(`x${i}`, text));
  const join = keys => keys.map(key => key.id).join(' OR ');
  const broad = domains.length ? domains : products;
  if (!broad.length) throw new Error('Add specific products or services before searching.');
  let expression = `(${join(broad)})`;
  if (domains.length && products.length) expression += ` AND (${join(products)})`;
  if (negatives.length) expression += ` AND NOT (${join(negatives)})`;
  if (expression.length > 500) throw new Error('The approved exclusions exceed the MID expression limit.');
  const groups = [{
    rationale: 'Find companies offering the products and services in the approved core business.',
    keywords: [...domains, ...products, ...negatives], expression,
  }];
  const phrases = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (!plannerStops.has(words[i]) && !plannerStops.has(words[i + 1]) &&
      !deferredAttribute.test(words[i]) && !deferredAttribute.test(words[i + 1])) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      // Phrases must appear verbatim, rather than crossing punctuation or clauses.
      if (positive.toLowerCase().includes(phrase) && !phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  const core = phrases.slice(0, 20).map((text, i) => keyword(`c${i}`, text));
  groups.push({
    rationale: 'Find companies describing the core phrases from the approved definition.',
    keywords: core.length ? core : broad,
    expression: join(core.length ? core : broad),
  });
  return groups;
}
