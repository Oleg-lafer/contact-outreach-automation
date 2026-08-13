import { normalize_bilingual_text } from "../../../shared_files_orchestrator/bilingual_text_(Deterministic).js";

// English and Hebrew alternatives remain visibly grouped for maintenance.
// Both groups are always active; these are semantic helpers, not a mode switch.
const EN = {
  contact: String.raw`contact|support|help|get[ -]?in[ -]?touch|reach[ -]?us|inquir|enquir|book(?: a)? (?:call|consultation)|schedule(?: a)? (?:call|consultation)|consultation|start(?: a| your)? project|work with us|request(?: a)? (?:quote|proposal)|free audit|let['’]?s talk|talk to us|new business|hire us`,
  message: String.raw`message|comment|inquiry|enquiry|details|description|additional information|questions?`,
  email: String.raw`e-?mail`,
  phone: String.raw`phone|mobile|telephone`,
  company: String.raw`company|organisation|organization|employer|business[ _-]?name|agency[ _-]?name`,
  role: String.raw`job[ _-]?title|job[ _-]?role|professional[ _-]?role|position|designation|occupation|(?:^|\s)role(?:\s|$)`,
  website: String.raw`web[ _-]?site|company[ _-]?url|business[ _-]?url|web[ _-]?address|domain`,
  country: String.raw`country|nation|country[ _-]?region`,
  firstName: String.raw`first[ _-]?name|given[ _-]?name`,
  lastName: String.raw`last[ _-]?name|family[ _-]?name|surname`,
  fullName: String.raw`(?:^|\s)(?:full[ _-]?)?(?:your[ _-]?)?name(?:\s|$)`,
  submit: String.raw`send|submit|message|contact|request|inquir|enquir|finish|complete|talk`,
  progression: String.raw`next(?: step)?|continue|proceed`,
  newsletter: String.raw`newsletter|subscribe|mailing list`,
  marketing: String.raw`marketing|newsletter|promotion|offers|advertising|updates`,
  privacy: String.raw`privacy|terms|consent|agree|data processing`,
  search: String.raw`search`,
  login: String.raw`sign[ -]?in|log[ -]?in`,
  directions: String.raw`directions?|route finder|calculate route|travel mode|wpgmza_input_(?:from|to)`,
  jobs: String.raw`job application|apply for (?:a )?job|careers?|vacanc(?:y|ies)`,
};

const HE = {
  contact: String.raw`צור קשר|צרו קשר|יצירת קשר|דברו איתנו|דבר איתנו|פנו אלינו|פנה אלינו|השאירו פרטים|השארת פרטים|בקשת הצעת מחיר|בקשו הצעת מחיר|קבעו פגישה|קביעת פגישה|תיאום פגישה|שיחת ייעוץ|ייעוץ ראשוני`,
  message: String.raw`הודעה|תוכן הפנייה|תוכן הפניה|פרטי הפנייה|פרטי הפניה|פרטים נוספים|איך נוכל לעזור|כיצד נוכל לעזור|ספרו לנו|הערות|שאלות`,
  email: String.raw`אימייל|אי-מייל|מייל|דוא["״']?ל|דואר אלקטרוני`,
  phone: String.raw`טלפון|טלפון נייד|נייד|מספר טלפון`,
  company: String.raw`שם החברה|חברה|ארגון|שם העסק|עסק|סוכנות`,
  role: String.raw`תפקיד|תואר תפקיד|משרה`,
  website: String.raw`אתר אינטרנט|כתובת אתר|אתר החברה|דומיין`,
  country: String.raw`מדינה|ארץ`,
  firstName: String.raw`שם פרטי`,
  lastName: String.raw`שם משפחה`,
  fullName: String.raw`שם מלא|השם שלך|שמך|שם איש קשר|(?:^|\s)שם(?:\s|$)`,
  submit: String.raw`שלח|שלחו|שליחה|שליחת הודעה|שלח הודעה|שלחו הודעה|שליחת פנייה|שליחת פניה|שליחת טופס|שלח טופס|סיום|אישור`,
  progression: String.raw`הבא|לשלב הבא|המשך|המשיכו|קדימה`,
  newsletter: String.raw`ניוזלטר|רשימת תפוצה|הרשמה לעדכונים|הצטרפות לרשימת`,
  marketing: String.raw`שיווק|פרסום|דיוור|ניוזלטר|מבצעים|הטבות|עדכונים שיווקיים|חומר פרסומי`,
  privacy: String.raw`פרטיות|תנאי שימוש|תנאים|הסכמה|מאשר|מאשרת|עיבוד מידע|עיבוד נתונים`,
  search: String.raw`חיפוש`,
  login: String.raw`התחברות|כניסה לחשבון`,
  directions: String.raw`הוראות הגעה|מסלול נסיעה|תכנון מסלול|איך מגיעים`,
  jobs: String.raw`הגשת מועמדות|מועמדות למשרה|דרושים|קריירה|משרות`,
};

function both(key: keyof typeof EN): RegExp {
  return new RegExp(`(?:${EN[key]})|(?:${HE[key]})`, "iu");
}

export const FORM_SEMANTICS = {
  contact: both("contact"),
  message: both("message"),
  email: both("email"),
  phone: both("phone"),
  company: both("company"),
  role: both("role"),
  website: both("website"),
  country: both("country"),
  firstName: both("firstName"),
  lastName: both("lastName"),
  fullName: both("fullName"),
  submit: both("submit"),
  progression: both("progression"),
  newsletter: both("newsletter"),
  marketing: both("marketing"),
  privacy: both("privacy"),
  search: both("search"),
  login: both("login"),
  directions: both("directions"),
  jobs: both("jobs"),
} as const;

export type FormSemanticKey = keyof typeof FORM_SEMANTICS;

export function matches_form_semantic(key: FormSemanticKey, value: string): boolean {
  return FORM_SEMANTICS[key].test(normalize_bilingual_text(value));
}

export function form_semantic_sources(): Record<FormSemanticKey, string> {
  return Object.fromEntries(
    Object.entries(FORM_SEMANTICS).map(([key, pattern]) => [key, pattern.source]),
  ) as Record<FormSemanticKey, string>;
}
