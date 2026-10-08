import {z} from "zod";
import sanitizeHtml from "sanitize-html";
import {canonicalJson} from "./agent-operation-schema";
const graphTimeSchema=z.object({dateTime:z.string().min(1).max(100),timeZone:z.string().min(1).max(100)});
export function providerBodyToPlainText(body: unknown): string {
  const parsed = z.object({ contentType: z.string(), content: z.string().max(400_000) }).parse(body);
  let text: string;
  if (parsed.contentType.toLowerCase() === "text") text = parsed.content;
  else if (parsed.contentType.toLowerCase() === "html") {
    const content = parsed.content.replace(/^[\s]*<html\b[^>]*>/i, "").replace(/<\/html>\s*$/i, "").replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "").replace(/^\s*<body\b[^>]*>/i, "").replace(/<\/body>\s*$/i, "");
    const wrapped = /^\s*<div\b[^>]*>([\s\S]*)<\/div>\s*$/i.exec(content);
    const sanitized = sanitizeHtml((wrapped ? wrapped[1] : content).replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(?:p|div|li)>/gi,"\n"), { allowedTags: [], allowedAttributes: {}, nonTextTags: ["script","style","textarea","option"] });
    text = sanitized.replace(/&(lt|gt|amp|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, (entity, name: string) => {
      const named: Record<string,string> = { lt:"<",gt:">",amp:"&",quot:'"',apos:"'","#39":"'" };
      if (named[name.toLowerCase()]) return named[name.toLowerCase()];
      const number = name.toLowerCase().startsWith("#x") ? Number.parseInt(name.slice(2),16) : Number.parseInt(name.slice(1),10);
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    });
  } else throw new Error("Unsupported task body format.");
  text = text.replace(/\r\n?/g,"\n");
  if (Buffer.byteLength(text,"utf8") > 65_536) throw new Error("Task body exceeds the plain-text limit.");
  return text;
}
export function graphTimezone(value: string) {
  const windows: Record<string,string> = { "UTC":"UTC", "Central Standard Time":"America/Chicago", "Eastern Standard Time":"America/New_York", "Mountain Standard Time":"America/Denver", "Pacific Standard Time":"America/Los_Angeles" };
  const timezone = windows[value] || value;
  try { new Intl.DateTimeFormat("en-US",{timeZone:timezone}); } catch { throw new Error("Task timezone is unsupported."); }
  return timezone;
}
function wallTime(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23" }).formatToParts(new Date(instant));
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}`;
}
export function graphDateTimeInstant(value: z.infer<typeof graphTimeSchema>) {
  const timezone = graphTimezone(value.timeZone); const local = value.dateTime.replace(/\.\d+/,"");
  const fraction = value.dateTime.match(/\.(\d+)/)?.[1] || "";
  if (/[1-9]/.test(fraction.slice(3))) throw new Error("Sub-millisecond provider time cannot be verified.");
  const millis = Number(fraction.slice(0,3).padEnd(3,"0"));
  if (/Z$|[+-]\d\d:\d\d$/.test(local)) { if (!Number.isFinite(Date.parse(local))) throw new Error("Invalid task time."); return new Date(Date.parse(local)+millis).toISOString(); }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local) || !Number.isFinite(Date.parse(`${local}Z`))) throw new Error("Invalid task time.");
  const nominal = Date.parse(`${local}Z`); let candidate = nominal;
  for (let index=0;index<4;index++) candidate += nominal - Date.parse(`${wallTime(new Date(candidate).toISOString(),timezone)}Z`);
  const matches = [candidate-3_600_000,candidate,candidate+3_600_000].filter(time => wallTime(new Date(time).toISOString(),timezone) === local);
  if (matches.length !== 1) throw new Error("Task time is ambiguous or unavailable.");
  return new Date(matches[0]+millis).toISOString();
}

/** Normalize only explicitly changed fields; untouched raw evidence stays exact. */
export function changedProviderFieldMatches(key:string,expected:unknown,actual:unknown):boolean {
  if(expected==null||actual==null)return expected==null&&actual==null;
  if(["start","end","dueDateTime","reminderDateTime"].includes(key))return graphDateTimeInstant(graphTimeSchema.parse(expected))===graphDateTimeInstant(graphTimeSchema.parse(actual));
  if(key==="body")return providerBodyToPlainText(expected)===providerBodyToPlainText(actual);
  return canonicalJson(expected)===canonicalJson(actual);
}