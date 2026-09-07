// One-shot: push the REAL dermatologist research (bake-off run A, the
// winning deep_research output) through open_report_window exactly as EVE
// would after a research turn. Production state (no EVE_STATE_DIR), so the
// Mac window genuinely opens — this is the end-to-end verification.
import { loadEnv } from "../src/core/config.js";
import { reportTools } from "../src/tools/report.js";

const openReport = reportTools.find((t) => t.name === "open_report_window");
if (!openReport) throw new Error("open_report_window not found");

const ret = await openReport.run({
  title: "Best dermatologist for surgery in Paris",
  question: "Find me the best dermatologist in surgery, Paris — judged on verifiable evidence, not marketing.",
  verdict:
    "There is no independently verifiable ranking of individual dermatologic surgeons in Paris — I searched hard for one and it does not exist. What IS verifiable: the Dermatology Department of Hôpital Saint-Louis (AP-HP, 10th arr.) is France's designated national reference centre for skin cancer and performs dermatologic surgery (tumeur excision, biopsies) as its daily core activity. On institutional evidence, that is the most defensible answer; any private clinic claiming 'the best' is marketing you cannot check.",
  method:
    "Best was defined as: board-registered dermatologists with documented surgical activity, attached to a hospital or a dedicated surgical centre, checkable against primary sources. Candidates were gathered from the Ordre des médecins context, AP-HP's own service pages, the Société Française de Dermatologie's surgical group, Doctolib neutral listings, and the clinics' own sites. SEO listicles and clinics' marketing pages were treated as LEADS, never evidence. Finalists were verified against the institution's own pages; every unverifiable claim became a caveat, not a finding.",
  picks: [
    {
      rank: 1,
      title: "Hôpital Saint-Louis — Service de Dermatologie (AP-HP)",
      subtitle: "Dermatologie chirurgicale · 10e arr., national reference centre",
      why: "The only pick whose excellence is documented by a primary source rather than advertising: AP-HP's own service page calls it 'centre expert de référence nationale et internationale', and its listed activity is verbatim 'Chirurgie dermatologique… exérèse de tumeurs cutanées malignes'. Multidisciplinary tumour boards for skin cancer on site. Chef de service: Pr Jean-David Bouaziz; Pr Céleste Lebbé (melanoma) is on the team.",
      evidence: [
        "AP-HP's own service page: 'centre expert de référence nationale et internationale' for skin, inflammatory and cancerous pathologies (aphp.fr/service/service-05-076)",
        "Listed specialised activity, verbatim: 'Chirurgie dermatologique et dermatologie instrumentale: exérèse de tumeurs cutanées malignes, biopsies et biopsies-exérèses à visée diagnostique'",
        "Institut du Cancer AP-HP label; coordinates the national reference network for cutaneous lymphomas",
      ],
      caveats: "Which specific physician performs the excisions day-to-day is not published; ask when booking. Public-hospital route may mean longer waits. No outcome-based ranking of individuals exists anywhere — this is institutional evidence, not a crown on one surgeon.",
      url: "https://www.aphp.fr/service/service-05-076",
      meta: ["Paris 10e", "public hospital (CPAM-reimbursed)", "referral via GP or dermatologist", "FR"],
    },
    {
      rank: 2,
      title: "Clinique de Chirurgie Dermatologique — 56 av. Victor Hugo",
      subtitle: "Dedicated dermatologic-surgery centre · 16e arr., Institut médical de chirurgie dermatologique",
      why: "The strongest private-sector option: a centre explicitly structured around dermatologic and reconstructive skin surgery and skin-cancer diagnosis, with multiple surgeons (structural evidence of a real surgical team, not a solo cosmetic practice). Long opening hours suggest high case volume. Listed on neutral platforms (Doctolib) as a 'centre de santé', conventionné.",
      evidence: [
        "Listed as 'Institut médical de chirurgie dermatologique, chirurgie réparatrice et diagnostique cancer de la peau' — surgery and skin-cancer diagnosis are the centre's stated purpose (Doctolib centre listing)",
        "Multiple specialist surgeons in one centre, 'du diagnostic au traitement chirurgical' of skin disease (the clinic's own page — marketing, but structurally checkable)",
        "Conventionné status and extended hours visible on the Doctolib listing",
      ],
      caveats: "Most of its evidence is its own marketing plus neutral directory listings — surgeon-by-surgeon academic credentials were not independently verifiable in this research. Ask for the operating surgeon's university title (PU-PH, ancien chef de clinique) and SFD Groupe Chirurgical membership before booking.",
      url: "https://www.doctolib.fr/centre-de-sante/paris/institut-medical-de-chirurgie-dermatologique-chirurgie-reparatrice-et-diagnostique-cancer-de-la-peau",
      meta: ["Paris 16e", "private, conventionné", "books via Doctolib", "FR/EN on request"],
    },
    {
      rank: 3,
      title: "Centre Villiers Batignolles — chirurgie dermatologique",
      subtitle: "Dedicated dermatologic surgery practice · 17e, near Parc Monceau",
      why: "A practice built around dermatologic surgery — cysts, lipomas, moles (grains de beauté) under local anaesthesia — rather than general dermatology. For a benign lesion with no cancer suspicion, this is the right weight of care: fast, specialised, no hospital referral needed.",
      evidence: [
        "Own page dedicated to 'Chirurgie Dermatologique Paris — Kyste, Lipome, Grain de beauté' describing routine local-anaesthesia excisions",
        "Hosts multiple doctors and surgeons for chirurgie dermatologique, médecine esthétique et laser",
      ],
      caveats: "Marketing-page evidence only; individual surgeons' credentials not verified against the register. Weaker on complex/cancer cases than Saint-Louis — use it for benign lesions.",
      url: "https://www.centre-villiers-batignolles.paris/chirurgie-dermatologique/",
      meta: ["Paris 17e", "books via Doctolib", "FR"],
    },
  ],
  sections: [
    {
      heading: "How to actually book (from Cergy)",
      body: "If a lesion worries you: GP or dermatologist in Cergy first, and ask for a referral letter to 'Dermatologie chirurgicale, Hôpital Saint-Louis'. If it is a benign mole/cyst: book directly at Villiers Batignolles or Victor Hugo via Doctolib. Bring your carte Vitale and student insurance details; photos of the lesion's evolution help. Questions worth asking at booking: is the surgeon a dermatologist or a plastic surgeon, how many similar cases per week, and (if cancer is suspected) will the case go to a multidisciplinary tumour board.",
    },
    {
      heading: "Why no single 'best surgeon' could be named",
      body: "France publishes no outcome-based registry for dermatologic surgery — no case volumes, no complication rates, no independent ranking that names individuals. The field's professional body (Groupe Chirurgical of the SFD) has no public patient-facing directory. Naming 'the best' anyway would have meant repeating marketing. The honest answer is a verified institution plus a shortlist you can settle with two phone calls.",
    },
  ],
  sources: [
    { label: "AP-HP — Service de Dermatologie, Hôpital Saint-Louis (official page)", url: "https://www.aphp.fr/service/service-05-076" },
    { label: "Groupe Chirurgical de la Société Française de Dermatologie", url: "https://groupechirsfd.com/" },
    { label: "Doctolib — dermatologue-chirurgical, Paris (neutral listings)", url: "https://www.doctolib.fr/dermatologue-chirurgical/paris" },
    { label: "Institut médical de chirurgie dermatologique (Victor Hugo, 16e) — Doctolib", url: "https://www.doctolib.fr/centre-de-sante/paris/institut-medical-de-chirurgie-dermatologique-chirurgie-reparatrice-et-diagnostique-cancer-de-la-peau" },
    { label: "Centre Villiers Batignolles — chirurgie dermatologique", url: "https://www.centre-villiers-batignolles.paris/chirurgie-dermatologique/" },
    { label: "Doctolib — Hôpital Saint-Louis, dermatologie chirurgicale", url: "https://www.doctolib.fr/dermatologue-chirurgical/paris-hopital-saint-louis" },
  ],
  caveats:
    "No comparison of Saint-Louis vs other AP-HP dermatology departments (Cochin, Tenon, Pitié-Salpêtrière) on surgical volume/outcomes was completed. Private clinics' self-descriptions were treated as marketing and never as evidence. Waiting times could not be verified — call. Report generated 6 Sep 2026; clinical staffing changes.",
});

console.log(ret);
