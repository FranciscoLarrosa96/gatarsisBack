import {
  CreateAdoptionApplicationDto,
  HomeSafetyStatus,
  HousingType,
} from "./adoption.dto";

type EmailRow = readonly [label: string, value: string];
type EmailSection = { title: string; rows: readonly EmailRow[] };

const yesNo = (value: boolean | undefined): string =>
  value === undefined ? "No aplica" : value ? "Sí" : "No";

const housingLabels: Record<HousingType, string> = {
  [HousingType.OWNED]: "Propia",
  [HousingType.RENTED]: "Alquilada",
  [HousingType.OTHER]: "Otra",
};

const safetyLabels: Record<HomeSafetyStatus, string> = {
  [HomeSafetyStatus.PROTECTED]: "Sí, ya cuenta con protección",
  [HomeSafetyStatus.WILL_INSTALL]:
    "Todavía no, pero se compromete a instalarla",
  [HomeSafetyStatus.NO]: "No",
  [HomeSafetyStatus.NOT_APPLICABLE]:
    "No aplica porque no hay aberturas o balcones de riesgo",
};

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );

const sectionsFor = (
  application: CreateAdoptionApplicationDto,
  catName?: string,
): readonly EmailSection[] => [
  ...(catName
    ? [{ title: "INTERÉS EN", rows: [["Michi", catName] as EmailRow] }]
    : []),
  {
    title: "CONTACTO",
    rows: [
      ["Nombre y apellido", application.applicant.fullName],
      ["Email", application.applicant.email],
      ["WhatsApp / teléfono", application.applicant.phone],
    ],
  },
  {
    title: "HOGAR Y EXPERIENCIA",
    rows: [
      ["Tiene otras mascotas", yesNo(application.home.hasOtherPets)],
      ["Veterinario/a de cabecera", yesNo(application.home.hasRegularVet)],
      ["Vacunación al día", yesNo(application.home.vaccinationsUpToDate)],
      ["Mascotas castradas", yesNo(application.home.petsNeutered)],
      [
        "Todo el hogar está de acuerdo",
        yesNo(application.home.householdAgrees),
      ],
      ["Tipo de vivienda", housingLabels[application.home.housingType]],
      [
        "El alquiler permite animales",
        yesNo(application.home.rentalAllowsPets),
      ],
      [
        "Cuenta con persona de confianza",
        yesNo(application.home.trustedCaregiver),
      ],
    ],
  },
  {
    title: "ADAPTACIÓN",
    rows: [
      [
        "Acompañará la adaptación",
        yesNo(application.adaptation.willingToSupportAdaptation),
      ],
    ],
  },
  {
    title: "SALUD Y CUIDADOS",
    rows: [
      ["Cuenta con ingreso fijo", yesNo(application.care.hasStableIncome)],
      [
        "Puede afrontar una emergencia veterinaria",
        yesNo(application.care.canCoverVetEmergency),
      ],
      [
        "Experiencia con mascotas anteriores",
        application.care.previousPetsDeathContext,
      ],
    ],
  },
  {
    title: "SEGURIDAD",
    rows: [
      [
        "Medidas de seguridad del hogar",
        safetyLabels[application.safety.homeSafetyStatus],
      ],
    ],
  },
  {
    title: "CASTRACIÓN Y SEGUIMIENTO",
    rows: [
      [
        "Acepta la castración obligatoria",
        yesNo(application.commitments.acceptsMandatoryNeutering),
      ],
      [
        "Se compromete a enviar comprobante",
        yesNo(application.commitments.commitsNeuteringProof),
      ],
      ["Acepta seguimiento", yesNo(application.commitments.acceptsFollowUp)],
    ],
  },
  {
    title: "COMPROMISOS",
    rows: [
      [
        "Acepta la cláusula de devolución responsable",
        yesNo(application.commitments.acceptsResponsibleReturnClause),
      ],
      [
        "Asume el compromiso a largo plazo",
        yesNo(application.commitments.acceptsLongTermCommitment),
      ],
    ],
  },
];

export const renderAdoptionEmail = (
  application: CreateAdoptionApplicationDto,
  catName?: string,
): { html: string; text: string } => {
  const sections = sectionsFor(application, catName);
  const text = [
    "NUEVA SOLICITUD DE ADOPCIÓN",
    "",
    ...sections.flatMap((section) => [
      section.title,
      ...section.rows.map(([label, value]) => `${label}: ${value}`),
      "",
    ]),
  ].join("\n");

  const htmlSections = sections
    .map(
      (section) => `
        <section style="margin:0 0 24px">
          <h2 style="margin:0 0 10px;color:#6245a5;font:700 14px Arial,sans-serif;letter-spacing:.06em">${escapeHtml(section.title)}</h2>
          <table role="presentation" style="width:100%;border-collapse:collapse">
            ${section.rows
              .map(
                ([label, value]) => `
                  <tr>
                    <th style="width:42%;padding:9px 12px;border:1px solid #ded7ee;background:#f4f0fb;color:#4b4358;text-align:left;vertical-align:top;font:600 13px Arial,sans-serif">${escapeHtml(label)}</th>
                    <td style="padding:9px 12px;border:1px solid #ded7ee;color:#2a2438;vertical-align:top;font:14px/1.5 Arial,sans-serif">${escapeHtml(value).replace(/\r?\n/g, "<br>")}</td>
                  </tr>`,
              )
              .join("")}
          </table>
        </section>`,
    )
    .join("");

  return {
    text,
    html: `<!doctype html>
      <html lang="es">
        <body style="margin:0;padding:24px;background:#faf9f6">
          <main style="max-width:680px;margin:0 auto;padding:28px;border:1px solid #ded7ee;border-radius:20px;background:#fff">
            <p style="margin:0 0 6px;color:#7c5cc4;font:700 12px Arial,sans-serif;letter-spacing:.08em">GATARSIS ADOPCIONES</p>
            <h1 style="margin:0 0 28px;color:#2a2438;font:700 26px Arial,sans-serif">Nueva solicitud de adopción</h1>
            ${htmlSections}
          </main>
        </body>
      </html>`,
  };
};
