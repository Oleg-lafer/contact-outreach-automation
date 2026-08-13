import {
  normalize_bilingual_text,
  safely_decode_url_text,
} from "../../shared_files_orchestrator/bilingual_text_(Deterministic).js";

const EN_CONTACT_ROUTE = String.raw`contact|support|help|get[ -]?in[ -]?touch|reach[ -]?us|inquir|enquir|book(?: a)? (?:meeting|call|demo|consultation)|schedule(?: a)? (?:meeting|call|demo|consultation)|consultation|talk to (?:sales|an? expert)|start(?: a| your)? project|work with us|request(?: a)? quote|request(?: a)? proposal|free audit|let['’]?s talk|talk to us|new business|hire us`;
const HE_CONTACT_ROUTE = String.raw`צור קשר|צרו קשר|יצירת קשר|דברו איתנו|דבר איתנו|פנו אלינו|פנה אלינו|השאירו פרטים|השארת פרטים|בקשת הצעת מחיר|בקשו הצעת מחיר|קבעו פגישה|קביעת פגישה|תיאום פגישה|שיחת ייעוץ|tzor kesher|yets?irat kesher|daberu itanu|hashairu pratim|teum pgisha`;

export const CONTACT_ROUTE_PATTERN = new RegExp(
  `(?:${EN_CONTACT_ROUTE})|(?:${HE_CONTACT_ROUTE})`,
  "iu",
);

const STRONG_CONTACT_ROUTE_PATTERN =
  /contact|inquir|enquir|get[ -]?in[ -]?touch|book(?: a)? (?:meeting|call|demo|consultation)|schedule(?: a)? (?:meeting|call|demo|consultation)|talk to (?:sales|an? expert)|start(?: a| your)? project|work with us|request(?: a)? (?:quote|proposal)|free audit|let['’]?s talk|talk to us|צור קשר|צרו קשר|יצירת קשר|דברו איתנו|פנו אלינו|השאירו פרטים|בקשת הצעת מחיר|קבעו פגישה|תיאום פגישה|שיחת ייעוץ/iu;

export function score_contact_route(searchable: string): number {
  const normalized = normalize_bilingual_text(
    safely_decode_url_text(searchable).replace(/[-_/]+/g, " "),
  );
  let score = 0;
  if (/^contact(?: us)?$/.test(normalized.trim())) score += 12;
  if (/contact|inquir|enquir/.test(normalized)) score += 9;
  if (/consultation/.test(normalized)) score += 8;
  if (STRONG_CONTACT_ROUTE_PATTERN.test(normalized)) score += 8;
  if (/support|help/.test(normalized)) score += 3;
  if (/^(?:צור קשר|צרו קשר|יצירת קשר)$/.test(normalized.trim())) score += 12;
  if (/צור קשר|צרו קשר|יצירת קשר|דברו איתנו|פנו אלינו|השאירו פרטים/.test(normalized)) score += 9;
  if (/בקשת הצעת מחיר|קבעו פגישה|תיאום פגישה|שיחת ייעוץ/.test(normalized)) score += 8;
  if (/tzor kesher|yets?irat kesher|daberu itanu|hashairu pratim|teum pgisha/.test(normalized)) score += 8;
  return score;
}

export function has_contact_route_intent(searchable: string): boolean {
  return CONTACT_ROUTE_PATTERN.test(
    normalize_bilingual_text(
      safely_decode_url_text(searchable).replace(/[-_/]+/g, " "),
    ),
  );
}
