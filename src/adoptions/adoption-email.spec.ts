import "reflect-metadata";
import {
  CreateAdoptionApplicationDto,
  HomeSafetyStatus,
  HousingType,
} from "./adoption.dto";
import { escapeHtml, renderAdoptionEmail } from "./adoption-email";

describe("adoption email", () => {
  it("escapes every applicant value in HTML and provides plain text", () => {
    const application = validApplication();
    application.applicant.fullName = '<img src=x onerror="alert(1)"> & Ana';
    application.care.previousPetsDeathContext =
      "Línea uno\n<script>alert('x')</script>";

    const rendered = renderAdoptionEmail(application);

    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Ana",
    );
    expect(rendered.html).toContain(
      "&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;",
    );
    expect(rendered.text).toContain("CONTACTO");
    expect(rendered.text).toContain("SALUD Y CUIDADOS");
    expect(rendered.text).toContain("Línea uno");
  });

  it("normalizes non-applicable conditional answers", () => {
    const application = validApplication();
    application.home.hasOtherPets = false;
    application.home.hasRegularVet = undefined;
    application.home.vaccinationsUpToDate = undefined;
    application.home.petsNeutered = undefined;
    application.home.housingType = HousingType.OWNED;
    application.home.rentalAllowsPets = undefined;

    const rendered = renderAdoptionEmail(application);
    expect(rendered.text).toContain("Veterinario/a de cabecera: No aplica");
    expect(rendered.text).toContain("El alquiler permite animales: No aplica");
  });

  it("escapes all HTML-sensitive characters", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#039;");
  });
});

function validApplication(): CreateAdoptionApplicationDto {
  return {
    applicant: {
      fullName: "Ana Pérez",
      email: "ana@example.com",
      phone: "2494000000",
    },
    home: {
      hasOtherPets: true,
      hasRegularVet: true,
      vaccinationsUpToDate: true,
      petsNeutered: true,
      householdAgrees: true,
      housingType: HousingType.RENTED,
      rentalAllowsPets: true,
      trustedCaregiver: true,
    },
    adaptation: { willingToSupportAdaptation: true },
    care: {
      hasStableIncome: true,
      canCoverVetEmergency: true,
      previousPetsDeathContext: "No tuve mascotas anteriormente.",
    },
    safety: { homeSafetyStatus: HomeSafetyStatus.PROTECTED },
    commitments: {
      acceptsMandatoryNeutering: true,
      commitsNeuteringProof: true,
      acceptsFollowUp: true,
      acceptsResponsibleReturnClause: true,
      acceptsLongTermCommitment: true,
    },
    website: "",
  };
}
