// Cloudflare Worker for sabres.studio.
// Serves the public site from dist/sabres, and handles rehearsal requests:
// POST /api/booking -> sends a formatted email to the studio through Resend,
// and a confirmation of receipt to the person who booked.
//
// Settings (deploy/sabres.jsonc -> "vars"): MAIL_TO, MAIL_CC, MAIL_FROM
// Secret (never in git): RESEND_API_KEY
//   npx wrangler@4 secret put RESEND_API_KEY --config deploy/sabres.jsonc

const MAX = { artist: 120, phone: 40, email: 120, notes: 3000, dayLabel: 60 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/booking") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleBooking(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleBooking(request, env) {
  // Only accept requests sent from the site itself.
  const origin = request.headers.get("Origin") || "";
  const allowed = [env.SITE_ORIGIN, "https://www.sabres.studio"].filter(Boolean);
  if (origin && !allowed.includes(origin)) return json({ ok: false, error: "origin" }, 403);

  let b;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  // Honeypot: real visitors never fill this hidden field.
  if (b.website) return json({ ok: true });

  const r = {
    artist: clean(b.artist, MAX.artist),
    phone: clean(b.phone, MAX.phone),
    email: clean(b.email, MAX.email),
    notes: clean(b.notes, MAX.notes),
    dayLabel: clean(b.dayLabel, MAX.dayLabel),
    date: String(b.date || ""),
    start: Number(b.start),
    hours: Number(b.hours),
    players: Number(b.players),
    price: Number(b.price),
  };
  const problem =
    !r.artist ? "artist" :
    r.phone.replace(/\D/g, "").length < 9 ? "phone" :
    !EMAIL_RE.test(r.email) ? "email" :
    !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? "date" :
    !(r.start >= 0 && r.start < 24) ? "start" :
    !(r.hours >= 1 && r.hours <= 12) ? "hours" :
    !(r.players >= 1 && r.players <= 50) ? "players" :
    r.notes.length < 10 ? "notes" : "";
  if (problem) return json({ ok: false, error: "invalid", field: problem }, 400);

  if (!env.RESEND_API_KEY) return json({ ok: false, error: "not_configured" }, 503);

  const hh = (h) => String(h % 24).padStart(2, "0") + ":00";
  const time = `${hh(r.start)}–${hh(r.start + r.hours)}`;
  const total = r.price > 0 ? r.hours * r.price : null;
  const [y, m, d] = r.date.split("-");
  const shortDate = `${+d}.${+m}`;

  const rows = [
    ["אמן / הרכב", r.artist],
    ["תאריך", r.dayLabel || `${+d}.${+m}.${y}`],
    ["שעות", `${time} (${r.hours} שעות)`],
    ["מספר נגנים", String(r.players)],
    ["טלפון", r.phone],
    ["מייל", r.email],
    ...(total ? [["מחיר", `${total.toLocaleString("he-IL")} ₪ (${r.price} ₪ לשעה)`]] : []),
  ];
  const text =
    `בקשה חדשה לקביעת חזרה באולפני סברס\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nמפרט:\n${r.notes}\n\nהחזרה נקבעת רק אחרי אישור מהאולפן.`;
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#F6EFE1;font-family:Arial,Helvetica,sans-serif;color:#25301A">
<div style="max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:22px;margin:0 0 4px;color:#38451F">בקשה חדשה לחזרה</h1>
<p style="margin:0 0 18px;color:#5D6450">אולפני סברס · נשלח מהאתר</p>
<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #D9CBAA">
${rows.map(([k, v]) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #EDE2CA;color:#5D6450;width:120px">${esc(k)}</td><td style="padding:10px 12px;border-bottom:1px solid #EDE2CA;font-weight:bold">${esc(v)}</td></tr>`).join("")}
</table>
<h2 style="font-size:16px;margin:20px 0 6px">מפרט</h2>
<div style="background:#fff;border:1px solid #D9CBAA;padding:12px;white-space:pre-wrap;line-height:1.6">${esc(r.notes)}</div>
<p style="margin:18px 0 0;color:#5D6450;font-size:13px">כדי לאשר, חוזרים למבקש בטלפון ${esc(r.phone)}, או עונים למייל הזה (התשובה תגיע ל־${esc(r.email)}).</p>
</div></body></html>`;

  const payload = {
    from: env.MAIL_FROM,
    to: [env.MAIL_TO],
    ...(env.MAIL_CC ? { cc: [env.MAIL_CC] } : {}),
    reply_to: r.email,
    subject: `בקשת חזרה: ${r.artist} · ${shortDate} · ${time}`,
    text,
    html,
  };
  const res = await sendMail(env, payload);
  if (!res.ok) {
    console.log("resend failed", res.status, await res.text());
    return json({ ok: false, error: "send_failed" }, 502);
  }

  // Confirmation of receipt to the person who booked. The studio already has the
  // request, so a failure here is logged but does not fail the booking.
  const mine = rows.filter(([k]) => k !== "מייל");
  const ctext =
    `היי ${r.artist},\n\nקיבלנו את הבקשה שלכם לחזרה באולפני סברס:\n\n` +
    mine.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nמפרט:\n${r.notes}\n\nזו עדיין לא הזמנה סופית. נחזור אליכם לטלפון ${r.phone} כדי לאשר את החזרה.\nאפשר גם לענות למייל הזה.\n\nאולפני סברס`;
  const chtml = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#F6EFE1;font-family:Arial,Helvetica,sans-serif;color:#25301A">
<div style="max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:22px;margin:0 0 4px;color:#38451F">קיבלנו את הבקשה שלכם</h1>
<p style="margin:0 0 18px;color:#5D6450">היי ${esc(r.artist)}, אלה הפרטים שנשלחו לאולפני סברס.</p>
<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #D9CBAA">
${mine.map(([k, v]) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #EDE2CA;color:#5D6450;width:120px">${esc(k)}</td><td style="padding:10px 12px;border-bottom:1px solid #EDE2CA;font-weight:bold">${esc(v)}</td></tr>`).join("")}
</table>
<h2 style="font-size:16px;margin:20px 0 6px">מפרט</h2>
<div style="background:#fff;border:1px solid #D9CBAA;padding:12px;white-space:pre-wrap;line-height:1.6">${esc(r.notes)}</div>
<p style="margin:18px 0 0;line-height:1.6"><b>זו עדיין לא הזמנה סופית.</b> נחזור אליכם לטלפון <span dir="ltr">${esc(r.phone)}</span> כדי לאשר את החזרה. אפשר גם לענות למייל הזה.</p>
<p style="margin:18px 0 0;color:#5D6450;font-size:13px">אולפני סברס · sabres.studio</p>
</div></body></html>`;
  const cres = await sendMail(env, {
    from: env.MAIL_FROM,
    to: [r.email],
    reply_to: env.MAIL_TO,
    subject: `קיבלנו את הבקשה שלכם · ${shortDate} · ${time}`,
    text: ctext,
    html: chtml,
  });
  if (!cres.ok) console.log("confirmation failed", cres.status, await cres.text());
  return json({ ok: true, confirmed: cres.ok });
}

function sendMail(env, payload) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function clean(v, max) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim().slice(0, max);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
