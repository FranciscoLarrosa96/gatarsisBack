import {
  RAFFLE_RESERVATION_RATE_LIMIT,
  RAFFLE_RESERVATION_RATE_WINDOW_MS,
  raffleReservationConfig,
} from "./raffle.config";

describe("raffle reservation configuration", () => {
  const names = [
    "RAFFLE_RESERVATION_MINUTES",
    "MAX_ACTIVE_RAFFLE_RESERVATIONS_PER_EMAIL",
  ] as const;
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of names) {
      previous.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("uses the approved defaults", () => {
    expect(raffleReservationConfig()).toEqual({
      reservationMinutes: 10,
      maxActiveReservationsPerEmail: 2,
    });
    expect(RAFFLE_RESERVATION_RATE_LIMIT).toBe(20);
    expect(RAFFLE_RESERVATION_RATE_WINDOW_MS).toBe(60_000);
  });

  it("loads explicit environment values", () => {
    process.env.RAFFLE_RESERVATION_MINUTES = "12";
    process.env.MAX_ACTIVE_RAFFLE_RESERVATIONS_PER_EMAIL = "3";
    expect(raffleReservationConfig()).toEqual({
      reservationMinutes: 12,
      maxActiveReservationsPerEmail: 3,
    });
  });

  it.each(["0", "-1", "1.5", "invalid"])(
    "rejects invalid positive integer %s",
    (value) => {
      process.env.RAFFLE_RESERVATION_MINUTES = value;
      expect(() => raffleReservationConfig()).toThrow(
        "RAFFLE_RESERVATION_MINUTES must be a positive integer",
      );
    },
  );
});
