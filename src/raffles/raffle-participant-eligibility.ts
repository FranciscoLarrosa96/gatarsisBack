import { Order, OrderStatus } from "../orders/entities/order.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "./entities/raffle-number.entity";

export function isEligibleRaffleParticipant(
  raffleNumber: Pick<RaffleNumber, "status" | "rafflePurchaseId">,
  order: Pick<Order, "status">,
): boolean {
  return (
    raffleNumber.status === RaffleNumberStatus.SOLD &&
    raffleNumber.rafflePurchaseId !== null &&
    order.status === OrderStatus.PAID
  );
}
