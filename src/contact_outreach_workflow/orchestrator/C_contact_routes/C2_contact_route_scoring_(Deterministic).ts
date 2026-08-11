export const CONTACT_ROUTE_PATTERN =
  /contact|support|help|get[ -]?in[ -]?touch|reach[ -]?us|inquir|enquir|book(?: a)? (?:meeting|call|demo|consultation)|schedule(?: a)? (?:meeting|call|demo|consultation)|consultation|talk to (?:sales|an? expert)|start(?: a| your)? project|work with us|request(?: a)? quote|request(?: a)? proposal|free audit|let['\u2019]?s talk|talk to us|new business|hire us/i;

const STRONG_CONTACT_ROUTE_PATTERN =
  /contact|inquir|enquir|get[ -]?in[ -]?touch|book(?: a)? (?:meeting|call|demo|consultation)|schedule(?: a)? (?:meeting|call|demo|consultation)|talk to (?:sales|an? expert)|start(?: a| your)? project|work with us|request(?: a)? (?:quote|proposal)|free audit|let['\u2019]?s talk|talk to us/i;

export function score_contact_route(searchable: string): number {
  const normalized = searchable.toLowerCase();
  let score = 0;
  if (/^contact(?: us)?$/.test(normalized.trim())) score += 12;
  if (/contact|inquir|enquir/.test(normalized)) score += 9;
  if (/consultation/.test(normalized)) score += 8;
  if (STRONG_CONTACT_ROUTE_PATTERN.test(normalized)) score += 8;
  if (/support|help/.test(normalized)) score += 3;
  return score;
}

export function has_contact_route_intent(searchable: string): boolean {
  return CONTACT_ROUTE_PATTERN.test(searchable);
}
