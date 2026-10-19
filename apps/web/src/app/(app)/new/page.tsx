"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useIsOwner } from "@/components/shell";
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui";
import { api, fileToBase64, tool, useApi } from "@/lib/client";
import { pkr } from "@/lib/format";

interface CreativeDraft {
  key: number;
  type: "image" | "video";
  file: File | null;
  url: string;
  uploaded?: { image_hash?: string; video_id?: string };
  headline: string;
  primary_text: string;
  name: string;
}

const STEPS = ["Audience & budget", "Creatives", "WhatsApp", "Review"];

export default function NewCampaignPage() {
  const owner = useIsOwner();
  const { data: settingsData } = useApi<any>("/settings");
  const s = settingsData?.settings;

  const [step, setStep] = useState(0);
  const [name, setName] = useState("SZ-KHI-Prospecting-WA");
  const [city, setCity] = useState("Karachi");
  const [cityKey, setCityKey] = useState<string | undefined>();
  const [cityResults, setCityResults] = useState<any[]>([]);
  const [ageMin, setAgeMin] = useState(20);
  const [ageMax, setAgeMax] = useState(40);
  const [gender, setGender] = useState<"female" | "male" | "all">("female");
  const [budget, setBudget] = useState(600);
  const [advantage, setAdvantage] = useState(true);
  const [creatives, setCreatives] = useState<CreativeDraft[]>([newDraft(1)]);
  const [welcome, setWelcome] = useState("Assalam o Alaikum! Sandalez mein khush aamdeed.");
  const [mode, setMode] = useState<"autofill" | "icebreakers">("autofill");
  const [autofill, setAutofill] = useState("Hi Sandalez! Mujhe yeh design chahiye. Size:");
  const [icebreakers, setIcebreakers] = useState("Price?\nSizes?\nDelivery time?");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (!s) return;
    setAgeMin(s.defaultAgeMin);
    setAgeMax(s.defaultAgeMax);
    setGender(s.defaultGender);
    if (s.defaultCityName) setCity(s.defaultCityName);
  }, [s]);

  useEffect(() => {
    if (city.trim().length < 2) return setCityResults([]);
    const t = setTimeout(() => {
      api(`/targeting/locations?q=${encodeURIComponent(city.trim())}`).then(setCityResults).catch(() => setCityResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [city]);

  if (!owner) return <Alert kind="warning">Only the owner can create campaigns.</Alert>;

  const cap = s?.maxDailyBudgetPkr as number | undefined;
  const errors: string[] = [];
  if (!name.trim()) errors.push("Give the campaign a name.");
  if (!city.trim()) errors.push("Choose a city.");
  if (ageMin > ageMax) errors.push("Minimum age is above maximum age.");
  if (advantage && ageMin > 25) errors.push("With Advantage+ audience Meta needs minimum age 25 or lower (turn it off for stricter ages).");
  if (!budget || budget <= 0) errors.push("Enter a daily budget.");
  if (cap !== undefined && budget > cap) errors.push(`Budget is above the cap of ${pkr(cap)}/day.`);
  const creativeErrors = creatives.flatMap((c, i) => [
    ...(!c.file && !c.url && !c.uploaded ? [`Creative ${i + 1}: add a file or URL.`] : []),
    ...(!c.primary_text.trim() ? [`Creative ${i + 1}: add primary text.`] : []),
  ]);
  const stepErrors = step === 0 ? errors : step === 1 ? creativeErrors : [];

  function update(key: number, patch: Partial<CreativeDraft>) {
    setCreatives((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch, ...(patch.file || patch.url !== undefined ? { uploaded: undefined } : {}) } : c)));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const payloadCreatives = [];
      for (const [i, c] of creatives.entries()) {
        let media: Record<string, string> = {};
        if (c.uploaded) media = c.uploaded as Record<string, string>;
        else if (c.file) {
          setProgress(`Uploading ${c.file.name} (${i + 1}/${creatives.length})…`);
          const up = await api("/assets/upload", { body: { type: c.type, base64: await fileToBase64(c.file), name: c.file.name } });
          const uploaded: Record<string, string> = c.type === "video" ? { video_id: up.video_id } : { image_hash: up.image_hash };
          update(c.key, { uploaded });
          media = uploaded;
        } else media = c.type === "video" ? { video_url: c.url } : { image_url: c.url };
        payloadCreatives.push({ type: c.type, name: c.name || undefined, headline: c.headline || undefined, primary_text: c.primary_text, ...media });
      }
      setProgress("Creating campaign, ad set, creatives and ads (all paused)… videos may take a minute to process.");
      const r = await tool("create_ctwa_campaign", {
        name,
        daily_budget: budget,
        ...(cityKey ? { city_key: cityKey, city } : { city }),
        age_min: ageMin,
        age_max: ageMax,
        gender,
        advantage_audience: advantage,
        creatives: payloadCreatives,
        welcome_message: welcome,
        ...(mode === "autofill" ? { autofill_message: autofill } : { icebreakers: icebreakers.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4) }),
      });
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (result) {
    return (
      <>
        <PageHeader title="Campaign created" />
        <Alert kind="success">
          “{name}” was created with {result.ads.length} ad(s). Everything is <strong>PAUSED</strong> — nothing is spending yet.
        </Alert>
        <Card className="mt-4" title="Next steps">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Check the ads in Meta Ads Manager (preview, welcome message, budget {pkr(result.daily_budget_pkr)}/day).</li>
            <li>On the Campaigns page, press <strong>Activate</strong> on the campaign. The ads go to review, then start.</li>
          </ol>
          <div className="mt-4 flex gap-2">
            <Link href="/campaigns"><Button variant="primary">Go to Campaigns</Button></Link>
            <Button onClick={() => { setResult(null); setStep(0); setCreatives([newDraft(Date.now())]); }}>Create another</Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New click-to-WhatsApp campaign" sub="Creates campaign, ad set, creatives and ads in one go — all paused." />
      <ol className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined} className={cx("rounded-full border px-3 py-1", i === step ? "border-accent font-semibold" : i < step ? "border-border text-text-2" : "border-border text-text-3")}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="City" hint={cityKey ? `Selected key ${cityKey}` : "Type and pick from the list"}>
              <Input value={city} onChange={(e) => { setCity(e.target.value); setCityKey(undefined); }} list="cities" />
              <datalist id="cities">{cityResults.map((c) => <option key={c.key} value={c.name}>{c.region}</option>)}</datalist>
              {cityResults.length > 0 && !cityKey && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {cityResults.slice(0, 5).map((c) => (
                    <button type="button" key={c.key} onClick={() => { setCity(c.name); setCityKey(c.key); }} className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-surface-2">
                      {c.name}{c.region ? `, ${c.region}` : ""}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min age"><Input type="number" min={18} max={65} value={ageMin} onChange={(e) => setAgeMin(Number(e.target.value))} /></Field>
              <Field label="Max age"><Input type="number" min={18} max={65} value={ageMax} onChange={(e) => setAgeMax(Number(e.target.value))} /></Field>
            </div>
            <Field label="Gender">
              <Select value={gender} onChange={(e) => setGender(e.target.value as any)}>
                <option value="female">Women</option>
                <option value="male">Men</option>
                <option value="all">Everyone</option>
              </Select>
            </Field>
            <Field label="Daily budget (PKR)" hint={cap ? `Cap ${pkr(cap)}/day` : undefined}>
              <Input type="number" min={100} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            </Field>
            <label className="flex items-start gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={advantage} onChange={(e) => setAdvantage(e.target.checked)} className="mt-1" />
              <span>Advantage+ audience <span className="block text-xs text-text-3">Lets Meta reach beyond these ages when it expects better results.</span></span>
            </label>
          </div>
        </Card>
      )}

      {step === 1 && (
        <div className="space-y-3">
          {creatives.map((c, i) => (
            <Card key={c.key} title={`Creative ${i + 1}`} actions={creatives.length > 1 && <Button size="sm" variant="ghost" onClick={() => setCreatives((cs) => cs.filter((x) => x.key !== c.key))}>Remove</Button>}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Type">
                  <Select value={c.type} onChange={(e) => update(c.key, { type: e.target.value as any })}>
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                  </Select>
                </Field>
                <Field label="Ad name (optional)"><Input value={c.name} onChange={(e) => update(c.key, { name: e.target.value })} placeholder="A1-Wedding-Pearl" /></Field>
                <Field label={c.type === "video" ? "Video file (up to 40 MB; larger: use a URL)" : "Image file"} hint={c.uploaded ? "Uploaded ✓" : undefined}>
                  <input type="file" accept={c.type === "video" ? "video/*" : "image/*"} onChange={(e) => update(c.key, { file: e.target.files?.[0] ?? null })} className="text-sm" />
                </Field>
                <Field label="…or public URL"><Input value={c.url} onChange={(e) => update(c.key, { url: e.target.value })} placeholder="https://…" /></Field>
                <Field label="Headline"><Input value={c.headline} maxLength={255} onChange={(e) => update(c.key, { headline: e.target.value })} placeholder="Shaadi-ready pearl flats" /></Field>
                <Field label="Primary text" hint={`${c.primary_text.length} characters — keep it short and honest`}>
                  <Textarea value={c.primary_text} maxLength={2200} onChange={(e) => update(c.key, { primary_text: e.target.value })} placeholder="Shaadi season ki tayyari? Pearl flats ab 30% OFF. COD + easy exchange." />
                </Field>
              </div>
            </Card>
          ))}
          {creatives.length < 10 && <Button onClick={() => setCreatives((cs) => [...cs, newDraft(Date.now())])}>+ Add another creative</Button>}
        </div>
      )}

      {step === 2 && (
        <Card>
          <div className="space-y-4">
            <Field label="Welcome message" hint="Shown when the WhatsApp chat opens"><Textarea value={welcome} onChange={(e) => setWelcome(e.target.value)} maxLength={500} /></Field>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" checked={mode === "autofill"} onChange={() => setMode("autofill")} /> Pre-filled message</label>
              <label className="flex items-center gap-2"><input type="radio" checked={mode === "icebreakers"} onChange={() => setMode("icebreakers")} /> Quick questions</label>
            </div>
            {mode === "autofill" ? (
              <Field label="Message the customer sends"><Input value={autofill} onChange={(e) => setAutofill(e.target.value)} maxLength={500} /></Field>
            ) : (
              <Field label="Quick questions (one per line, max 4)"><Textarea value={icebreakers} onChange={(e) => setIcebreakers(e.target.value)} /></Field>
            )}
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title="Review">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-text-3">Campaign</dt><dd className="font-medium">{name}</dd></div>
            <div><dt className="text-text-3">Budget</dt><dd className="font-medium">{pkr(budget)}/day</dd></div>
            <div><dt className="text-text-3">Audience</dt><dd>{city}, {gender === "female" ? "women" : gender === "male" ? "men" : "everyone"} {ageMin}–{ageMax}{advantage ? " (Advantage+)" : ""}</dd></div>
            <div><dt className="text-text-3">Creatives</dt><dd>{creatives.length} ({creatives.map((c) => c.type).join(", ")})</dd></div>
            <div className="sm:col-span-2"><dt className="text-text-3">WhatsApp</dt><dd>{welcome} → {mode === "autofill" ? `“${autofill}”` : icebreakers.split("\n").filter(Boolean).join(" · ")}</dd></div>
          </dl>
          <div className="mt-3"><Alert>Everything is created <strong>paused</strong>. You activate it later on the Campaigns page.</Alert></div>
        </Card>
      )}

      {stepErrors.length > 0 && <div className="mt-3"><Alert kind="warning"><ul className="list-disc pl-4">{stepErrors.map((e) => <li key={e}>{e}</li>)}</ul></Alert></div>}
      {progress && <div className="mt-3"><Alert>{progress}</Alert></div>}
      {err && <div className="mt-3"><Alert kind="error">{err}</Alert></div>}

      <div className="mt-4 flex justify-between">
        <Button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>Back</Button>
        {step < 3 ? (
          <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={stepErrors.length > 0}>Next</Button>
        ) : (
          <Button variant="primary" onClick={submit} loading={busy} disabled={errors.length > 0 || creativeErrors.length > 0}>Create paused campaign</Button>
        )}
      </div>
    </>
  );
}

function newDraft(key: number): CreativeDraft {
  return { key, type: "image", file: null, url: "", headline: "", primary_text: "", name: "" };
}
