// Two languages, one dictionary. Keys missing from a language fall back to
// Swedish, so a half-finished translation never renders as an empty page.

export const LANGS = ["sv", "en"];
export const DEFAULT_LANG = "sv";

const sv = {
  site_name: "Roligast",
  site_tagline: "Det roligaste på nätet – betygsatt av oss som skrattar",
  meta_description:
    "Samla skämt, klipp och annat kul – och sätt betyg 1 till 10. Inget konto behövs.",

  nav_add: "+ Lägg till",
  nav_login: "Logga in",
  nav_logout: "Logga ut",
  nav_mine: "Mitt",
  lang_other: "English",
  lang_other_title: "Switch to English",

  hero_title: "Vad är roligast?",
  hero_sub:
    "Lägg upp ett skämt, ett klipp eller något annat kul. Alla får sätta betyg 1–10 – inget konto behövs.",

  sort_top: "Topplistan",
  sort_hot: "Hetast",
  sort_new: "Senaste",
  filter_all: "Allt",
  kind_joke: "Skämt",
  kind_clip: "Klipp",
  kind_image: "Bilder",
  kind_link: "Länkar",
  kind_joke_one: "Skämt",
  kind_clip_one: "Klipp",
  kind_image_one: "Bild",
  kind_link_one: "Länk",

  empty_title: "Här är det tomt än så länge",
  empty_body: "Bli först med att lägga upp något roligt.",
  empty_cta: "Lägg till något roligt",

  rating_none: "Inga betyg än",
  rating_of_ten: "av 10",
  rating_count_one: "1 betyg",
  rating_count_other: "%{count} betyg",
  rate_prompt: "Vad tycker du? Sätt betyg 1–10",
  rate_prompt_short: "Sätt betyg",
  your_rating: "Ditt betyg: %{value}",
  rate_saved: "Tack för ditt betyg!",
  rate_change: "Klicka på en ny siffra för att ändra.",
  rate_error: "Betyget kunde inte sparas. Försök igen.",

  by_author: "av %{name}",
  anonymous: "Anonym",
  open_original: "Öppna originalet",
  read_more: "Läs mer",
  share_copy: "Kopiera länk",
  share_copied: "Länken är kopierad",
  back_home: "Till startsidan",
  delete_post: "Ta bort",
  delete_confirm: "Ta bort det här inlägget?",

  add_title: "Lägg till något roligt",
  add_intro:
    "Ett skämt du skrivit själv, ett klipp du hittat eller en bild som får folk att skratta. Fyll i rubrik och minst en av texten eller länken.",
  field_title: "Rubrik",
  field_title_ph: "Vad handlar det om?",
  field_body: "Skämtet eller texten",
  field_body_ph: "Skriv skämtet här … (valfritt om du lägger in en länk)",
  field_url: "Länk",
  field_url_ph: "https://www.youtube.com/watch?v=…",
  field_url_help:
    "YouTube, Vimeo, TikTok, Instagram, Streamable, Imgur eller en direktlänk till en bild eller video visas direkt på sidan.",
  field_name: "Ditt namn",
  field_name_ph: "Valfritt – annars står det Anonym",
  field_name_help_user: "Namnet visas vid dina inlägg. Din e-post visas aldrig.",
  submit_post: "Publicera",
  submitting_post: "Publicerar …",
  preview_heading: "Så här kommer länken att visas",

  err_title_required: "Skriv en rubrik.",
  err_title_long: "Rubriken får vara högst 120 tecken.",
  err_body_long: "Texten får vara högst 5000 tecken.",
  err_url_invalid:
    "Länken ser inte ut att fungera. Klistra in hela adressen, till exempel https://youtu.be/…",
  err_content_required: "Fyll i texten eller lägg in en länk.",
  err_name_long: "Namnet får vara högst 40 tecken.",
  err_name_at: "Namnet får inte innehålla @ (din e-post visas aldrig publikt).",
  err_rate_limit: "Du har lagt upp mycket på kort tid. Vänta en stund.",
  err_generic: "Något gick fel. Försök igen.",

  login_title: "Logga in",
  login_intro:
    "Ange din e-postadress så skickar vi en engångskod. Har du inget konto skapas det automatiskt.",
  login_why:
    "Du behöver inte logga in för att lägga upp eller betygsätta – men inloggad följer dina inlägg och betyg med dig mellan enheter.",
  field_email: "E-postadress",
  remember_email: "Kom ihåg min e-post på den här enheten",
  send_code: "Skicka kod",
  sending_code: "Skickar kod …",
  verify_title: "Kolla din mejl",
  verify_intro: "Vi har skickat en sexsiffrig kod till %{email}. Ange den här:",
  field_pin: "Engångskod",
  sign_in: "Logga in",
  signing_in: "Loggar in …",
  resend_code: "Skicka ny kod",
  resending_code: "Skickar ny kod …",
  use_other_email: "Använd en annan e-postadress",

  err_email_invalid: "Ange en giltig e-postadress.",
  pin_too_soon: "Vänta en minut innan du begär en ny kod.",
  pin_expired: "Koden har gått ut. Begär en ny kod.",
  pin_attempts: "För många försök. Begär en ny kod.",
  pin_wrong: "Fel kod, försök igen.",

  me_title: "Mitt",
  me_signed_in_as: "Inloggad som %{email}",
  me_display_name: "Visningsnamn",
  me_display_name_help:
    "Visas vid dina inlägg. Lämna tomt för att synas som %{fallback}.",
  me_save: "Spara",
  me_saving: "Sparar …",
  me_saved: "Sparat.",
  me_posts: "Mina inlägg",
  me_ratings: "Mina betyg",
  me_no_posts: "Du har inte lagt upp något än.",
  me_no_ratings: "Du har inte satt några betyg än.",
  me_local_note:
    "Inlägg och betyg du lämnade utan att vara inloggad på den här enheten räknas också med.",

  not_found_title: "Sidan finns inte",
  not_found_body: "Länken kan vara gammal eller felstavad.",

  footer_about:
    "Roligast samlar det roligaste på nätet och låter alla sätta betyg 1 till 10.",
  footer_add: "Lägg till något",

  time_just_now: "nyss",
  time_minutes: "%{n} min sedan",
  time_hours: "%{n} tim sedan",
  time_days: "%{n} dagar sedan",
};

const en = {
  site_name: "Roligast",
  site_tagline: "The funniest things on the internet – rated by the people laughing",
  meta_description:
    "Collect jokes, clips and other funny things – and rate them 1 to 10. No account needed.",

  nav_add: "+ Add",
  nav_login: "Sign in",
  nav_logout: "Sign out",
  nav_mine: "Mine",
  lang_other: "Svenska",
  lang_other_title: "Byt till svenska",

  hero_title: "What is the funniest?",
  hero_sub:
    "Post a joke, a clip or anything else that made you laugh. Everyone can rate it 1–10 – no account needed.",

  sort_top: "Top rated",
  sort_hot: "Hot",
  sort_new: "Newest",
  filter_all: "Everything",
  kind_joke: "Jokes",
  kind_clip: "Clips",
  kind_image: "Pictures",
  kind_link: "Links",
  kind_joke_one: "Joke",
  kind_clip_one: "Clip",
  kind_image_one: "Picture",
  kind_link_one: "Link",

  empty_title: "Nothing here yet",
  empty_body: "Be the first to post something funny.",
  empty_cta: "Add something funny",

  rating_none: "No ratings yet",
  rating_of_ten: "out of 10",
  rating_count_one: "1 rating",
  rating_count_other: "%{count} ratings",
  rate_prompt: "What do you think? Rate it 1–10",
  rate_prompt_short: "Rate it",
  your_rating: "Your rating: %{value}",
  rate_saved: "Thanks for rating!",
  rate_change: "Pick another number to change it.",
  rate_error: "The rating could not be saved. Try again.",

  by_author: "by %{name}",
  anonymous: "Anonymous",
  open_original: "Open the original",
  read_more: "Read more",
  share_copy: "Copy link",
  share_copied: "Link copied",
  back_home: "Back to the front page",
  delete_post: "Delete",
  delete_confirm: "Delete this post?",

  add_title: "Add something funny",
  add_intro:
    "A joke you wrote, a clip you found or a picture that makes people laugh. Fill in a title and at least one of the text or the link.",
  field_title: "Title",
  field_title_ph: "What is it about?",
  field_body: "The joke or text",
  field_body_ph: "Type the joke here … (optional if you add a link)",
  field_url: "Link",
  field_url_ph: "https://www.youtube.com/watch?v=…",
  field_url_help:
    "YouTube, Vimeo, TikTok, Instagram, Streamable, Imgur or a direct link to an image or video is shown right on the page.",
  field_name: "Your name",
  field_name_ph: "Optional – otherwise it says Anonymous",
  field_name_help_user:
    "Shown on your posts. Your email address is never made public.",
  submit_post: "Post it",
  submitting_post: "Posting …",
  preview_heading: "This is how the link will look",

  err_title_required: "Please write a title.",
  err_title_long: "The title can be at most 120 characters.",
  err_body_long: "The text can be at most 5000 characters.",
  err_url_invalid:
    "That link does not look right. Paste the whole address, for example https://youtu.be/…",
  err_content_required: "Add some text or a link.",
  err_name_long: "The name can be at most 40 characters.",
  err_name_at: "The name cannot contain @ (your email is never made public).",
  err_rate_limit: "You have posted a lot in a short time. Please wait a while.",
  err_generic: "Something went wrong. Please try again.",

  login_title: "Sign in",
  login_intro:
    "Enter your email address and we will send you a one-time code. If you do not have an account yet, one is created for you.",
  login_why:
    "You do not have to sign in to post or rate – but signed in, your posts and ratings follow you between devices.",
  field_email: "Email address",
  remember_email: "Remember my email on this device",
  send_code: "Send code",
  sending_code: "Sending code …",
  verify_title: "Check your email",
  verify_intro: "We sent a six-digit code to %{email}. Enter it here:",
  field_pin: "One-time code",
  sign_in: "Sign in",
  signing_in: "Signing in …",
  resend_code: "Send a new code",
  resending_code: "Sending a new code …",
  use_other_email: "Use a different email address",

  err_email_invalid: "Enter a valid email address.",
  pin_too_soon: "Wait a minute before asking for a new code.",
  pin_expired: "The code has expired. Ask for a new one.",
  pin_attempts: "Too many attempts. Ask for a new code.",
  pin_wrong: "Wrong code, try again.",

  me_title: "Mine",
  me_signed_in_as: "Signed in as %{email}",
  me_display_name: "Display name",
  me_display_name_help: "Shown on your posts. Leave empty to appear as %{fallback}.",
  me_save: "Save",
  me_saving: "Saving …",
  me_saved: "Saved.",
  me_posts: "My posts",
  me_ratings: "My ratings",
  me_no_posts: "You have not posted anything yet.",
  me_no_ratings: "You have not rated anything yet.",
  me_local_note:
    "Posts and ratings you left on this device without signing in are included too.",

  not_found_title: "Page not found",
  not_found_body: "The link may be old or misspelled.",

  footer_about:
    "Roligast collects the funniest things on the internet and lets everyone rate them 1 to 10.",
  footer_add: "Add something",

  time_just_now: "just now",
  time_minutes: "%{n} min ago",
  time_hours: "%{n} h ago",
  time_days: "%{n} days ago",
};

const DICTS = { sv, en };

export const normalizeLang = (value) =>
  LANGS.includes(value) ? value : DEFAULT_LANG;

// Picks a language from the browser's Accept-Language for a first-time visitor.
export function langFromHeader(header) {
  const wanted = String(header || "")
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase().slice(0, 2))
    .find((code) => LANGS.includes(code));
  return wanted || DEFAULT_LANG;
}

export function translate(lang, key, params) {
  const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
  let text = dict[key];
  if (text === undefined) text = DICTS[DEFAULT_LANG][key];
  if (text === undefined) return key;
  if (!params) return text;
  return text.replace(/%\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name])
  );
}

// Bound to a language so views can just call t("key").
export const translator = (lang) => (key, params) => translate(lang, key, params);
