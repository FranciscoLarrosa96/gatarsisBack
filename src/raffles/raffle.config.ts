const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

export const raffleReservationConfig = () => ({
  reservationMinutes: positiveInteger("RAFFLE_RESERVATION_MINUTES", 10),
  maxActiveReservationsPerEmail: positiveInteger(
    "MAX_ACTIVE_RAFFLE_RESERVATIONS_PER_EMAIL",
    2,
  ),
});

export const RAFFLE_RESERVATION_RATE_LIMIT = 20;
export const RAFFLE_RESERVATION_RATE_WINDOW_MS = 60_000;
