/** Default Bing research templates for an approved business definition.
 *
 * The definition is an analyst sentence ("Find companies that sell claims software to insurers.
 * Exclude brokers."). A template must read as a question about one company, so this keeps the core
 * business phrase, drops the lead-in and the exclusions, and fits the verb to a question.
 * Size, geography and ownership words are deferred review details and never drive a query. */

const GENERIC =
  "What business is {company} in, and which products and customers define it? Website: {website}";
const PLACEHOLDER = /^(?:the\s+)?approved\s+business\s+criteria\.?$/i;
const EXCLUSION =
  /\b(?:exclud(?:e|es|ed|ing)|except(?:ing)?|but\s+not|not\s+including|other\s+than|do(?:es)?\s+not\s+include)\b/i;
const SINGULAR: Record<string, string> = {
  company: "company", companies: "company", firm: "firm", firms: "firm", business: "business", businesses: "business",
  vendor: "vendor", vendors: "vendor", provider: "provider", providers: "provider", target: "target", targets: "target",
  organization: "organization", organizations: "organization", organisation: "organisation", organisations: "organisation",
  operator: "operator", operators: "operator", developer: "developer", developers: "developer",
  manufacturer: "manufacturer", manufacturers: "manufacturer", distributor: "distributor", distributors: "distributor",
  supplier: "supplier", suppliers: "supplier", player: "player", players: "player",
};
const COMPANY_NOUN = "(?:" + Object.keys(SINGULAR).join("|") + ")";
const BARRIER = "(?:for|of|to|in|on|with|by|at|from|serving|used|using|and|or)";
const LEAD = `((?:(?!${BARRIER}\\b)[\\w&/'’.-]+\\s+){0,3}?)(${COMPANY_NOUN})\\s+`;
const DETERMINER = "(?:(?:all|any|the|some)\\s+)?";
const RELATIVE = new RegExp(`^${DETERMINER}${LEAD}(that|which|who|whose)\\s+(.+)$`, "i");
const NOUN_THEN_LINK = new RegExp(
  `^${DETERMINER}${LEAD}(in|operating in|active in|focused on|focusing on|specializing in|specialising in|with|serving|providing|offering|selling|building|developing|making|manufacturing|distributing|supplying|delivering|producing|operating)\\s+(.+)$`,
  "i",
);
const LEAD_INS = [
  /^please\s+/i,
  /^(?:we|i)(?:'re|’re|\s+are|\s+am)?\s+(?:seek(?:ing)?|want(?:ing)?|need(?:ing)?|target(?:ing)?|looking\s+for|interested\s+in|focus(?:ed|ing)?\s+on)\s+/i,
  /^(?:seek(?:ing)?|looking\s+for|target(?:ing)?)\s+/i,
  /^(?:find|identify|screen(?:\s+for)?|search\s+for|look\s+for|show(?:\s+me)?|list|get|source|locate|discover)\s+(?:me\s+|us\s+)?/i,
];
// Words that describe size, geography or ownership. They are review details, so they are dropped.
const DEFERRED_MODIFIER =
  /^(?:mid-?market|mid-?sized?|small|large|lower|upper|private|public|privately-held|family-owned|(?:pe|sponsor|venture)-backed|us|u\.s\.|usa|uk|eu|north|european|canadian|american|global|international|domestic|regional|national|profitable|growing|high-growth|fast-growing|established)(?:-[\w]+)*$/i;
// Verbs whose base form is not also a common noun; safe to recognise at the start of a phrase.
const SURE_VERBS = new Set(
  "sell provide offer develop build operate manufacture distribute produce supply deliver publish underwrite originate resell install integrate generate derive earn specialize serve create automate digitize".split(" "),
);
const OTHER_VERBS = new Set(
  "make run own market license design host maintain administer process manage service support enable help implement handle monitor track store ship transport finance lend import export refine grow consult advise connect analyze analyse insure lease rent focus use have".split(" "),
);
const GERUNDS: Record<string, [string, "verb" | "be"]> = {
  in: ["operate in", "verb"], "operating in": ["operate in", "verb"], "active in": ["active in", "be"],
  "focused on": ["focused on", "be"], "focusing on": ["focus on", "verb"], "specializing in": ["specialize in", "verb"],
  "specialising in": ["specialize in", "verb"], with: ["have", "verb"], serving: ["serve", "verb"],
  providing: ["provide", "verb"], offering: ["offer", "verb"], selling: ["sell", "verb"], building: ["build", "verb"],
  developing: ["develop", "verb"], making: ["make", "verb"], manufacturing: ["manufacture", "verb"],
  distributing: ["distribute", "verb"], supplying: ["supply", "verb"], delivering: ["deliver", "verb"],
  producing: ["produce", "verb"], operating: ["operate", "verb"],
};
// Nouns that name kinds of company, so "Is {company} among the ..." reads better than "offer".
const TYPE_NOUN =
  /\b(?:companies|firms|businesses|vendors|providers|brokers|carriers|adjusters|administrators|agencies|consultancies|wholesalers|retailers|resellers|integrators|lenders|insurers|distributors|manufacturers|developers|operators|suppliers)$/i;

function baseOf(word: string): string {
  const w = word.toLowerCase();
  const irregular: Record<string, string> = { has: "have", is: "be", are: "be", does: "do" };
  if (irregular[w]) return irregular[w];
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
function thirdOf(word: string): string {
  const w = word.toLowerCase();
  const irregular: Record<string, string> = { have: "has", be: "is", are: "is", do: "does", go: "goes" };
  if (irregular[w]) return irregular[w];
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(?:s|sh|ch|x|z|o)$/.test(w)) return `${w}es`;
  return `${w}s`;
}
const isSure = (word: string) => SURE_VERBS.has(baseOf(word));
const isVerb = (word: string) => SURE_VERBS.has(baseOf(word)) || OTHER_VERBS.has(baseOf(word));

/** Convert the first verb, and any sure verb joined by "and", "or" or a comma, to base or third-person form. */
function conjugate(phrase: string, form: "base" | "third"): string {
  const convert = (word: string) => (form === "base" ? baseOf(word) : thirdOf(baseOf(word)));
  const [first, ...rest] = phrase.split(/\s+/);
  const head = isVerb(first) || /^(?:is|are|has)$/i.test(first) ? convert(first) : first;
  const text = rest.join(" ");
  // A verb that is also a common noun ("support", "services") only counts when more than a preposition follows.
  const tail = text.replace(/((?:,|\band\b|\bor\b)\s+(?:also\s+)?)([a-z]+)/gi, (all, joiner: string, word: string, offset: number) => {
    const next = /^\s+([a-z]+)/i.exec(text.slice(offset + all.length))?.[1]?.toLowerCase();
    return isSure(word) || (isVerb(word) && next && !new RegExp(`^${BARRIER}$`).test(next)) ? `${joiner}${convert(word)}` : all;
  });
  return [head, tail].filter(Boolean).join(" ");
}

const lowerFirst = (text: string) => text.replace(/^([A-Z][a-z]+(?:-[a-z]+)*)(?=\s|$)/, (word) => word.toLowerCase());
const article = (phrase: string) => {
  const word = phrase.split(/\s+/)[0] ?? "";
  if (/^[A-Z]{2,}\b/.test(word)) return /^[AEFHILMNORSX]/.test(word) ? "an" : "a";
  return /^[aeiou]/i.test(word) && !/^(?:uni|use|usu|uti|eu|one)/i.test(word) ? "an" : "a";
};

/** The core business of a definition as plain text, without lead-in or exclusions. */
export function coreBusinessPhrase(definition: string): string {
  let text = String(definition ?? "").replace(/\s+/g, " ").trim();
  if (!text || PLACEHOLDER.test(text)) return "";
  const exclusion = EXCLUSION.exec(text);
  if (exclusion) text = text.slice(0, exclusion.index);
  text = text.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? "";
  const trim = (value: string) => value.replace(/(?:[\s,;:(–—.!?-]|\b(?:and|but|or)\b)+$/i, "").trim();
  text = trim(text);
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    for (const lead of LEAD_INS) text = text.replace(lead, "");
    if (text === before) break;
  }
  text = trim(text);
  if (text.length > 300) text = trim(text.slice(0, 300).replace(/\s+\S*$/, ""));
  return text;
}

function question(core: string): string {
  if (!core) return GENERIC;
  const link = NOUN_THEN_LINK.exec(core);
  const relative = RELATIVE.exec(core);
  const described = (modifiers: string, noun: string) => {
    const kept = modifiers.split(/\s+/).filter((word) => word && !DEFERRED_MODIFIER.test(word));
    const subject = [...kept.map((word, index) => (index === 0 ? lowerFirst(word) : word)), SINGULAR[noun.toLowerCase()] ?? noun.toLowerCase()].join(" ");
    return { kept: kept.length, subject: `${article(subject)} ${subject}` };
  };
  let result: { subject: string; tail: string } | undefined;
  let verbPhrase = "";
  let bePhrase = "";
  if (relative) {
    const [, modifiers, noun, connector, rest] = relative;
    const shaped = described(modifiers, noun);
    if (connector.toLowerCase() === "whose") result = { ...shaped, tail: `whose ${rest.trim()}` };
    else if (shaped.kept) result = { ...shaped, tail: `that ${conjugate(rest.trim(), "third")}` };
    else if (/^(?:is|are)\s/i.test(rest)) bePhrase = rest.trim().replace(/^\S+\s+/, "");
    else verbPhrase = conjugate(rest.trim(), "base");
  } else if (link) {
    const [, modifiers, noun, connector, rest] = link;
    const [base, kind] = GERUNDS[connector.toLowerCase().replace(/\s+/g, " ")] ?? ["operate in", "verb"];
    const shaped = described(modifiers, noun);
    if (shaped.kept) result = { ...shaped, tail: `that ${kind === "be" ? `is ${base}` : conjugate(base, "third")} ${rest.trim()}` };
    else if (kind === "be") bePhrase = `${base} ${rest.trim()}`;
    else verbPhrase = `${base} ${rest.trim()}`;
  } else if (isSure(core.split(/\s+/)[0])) verbPhrase = conjugate(core, "base");
  if (verbPhrase) return `Does {company} ${verbPhrase}? Website: {website}`;
  if (bePhrase)
    return /^(?:an?|the|one|focused|active|engaged|primarily|mainly|also|in|part|owned)\b/i.test(bePhrase)
      ? `Is {company} ${bePhrase}? Website: {website}`
      : `Is {company} among the ${bePhrase}? Website: {website}`;
  if (result) return `Is {company} ${result.subject} ${result.tail}? Website: {website}`;
  const noun = lowerFirst(core.replace(/^(?:the|all|any|some)\s+/i, ""));
  const head = noun.split(/\s+(?:of|for|that|which|serving|in|used|with)\s+/i)[0];
  return TYPE_NOUN.test(head) ? `Is {company} among the ${noun}? Website: {website}` : `Does {company} offer ${noun}? Website: {website}`;
}

/** Four grammatical Bing research templates for a definition. {company} and {website} are filled per company. */
export function defaultResearchQueries(definition: string): string[] {
  return [
    question(coreBusinessPhrase(definition)),
    "Which products and customer workflows show that this is a core business for {company}? Website: {website}",
    "Does {company} sell a software product or mainly provide services? Website: {website}",
    "Which primary sources support or contradict the business fit for {company}? Website: {website}",
  ];
}
