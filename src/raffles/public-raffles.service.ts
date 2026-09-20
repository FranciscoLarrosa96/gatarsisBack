import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "./entities/raffle-number.entity";
import { Raffle, RaffleStatus } from "./entities/raffle.entity";

type PublicNumberStatsRow = {
  total: string;
  available: string;
  reserved: string;
  sold: string;
};

const PUBLIC_RAFFLE_STATUSES = [
  RaffleStatus.ACTIVE,
  RaffleStatus.PAUSED,
  RaffleStatus.CLOSED,
  RaffleStatus.DRAWN,
];

@Injectable()
export class PublicRafflesService {
  constructor(private readonly dataSource: DataSource) {}

  async active() {
    const raffle = await this.dataSource.getRepository(Raffle).findOne({
      where: { status: RaffleStatus.ACTIVE },
      select: this.publicSelect(),
    });
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_ACTIVE_NOT_FOUND",
        message: "No hay una rifa activa.",
      });
    return this.view(raffle);
  }

  async detail(id: string) {
    const raffle = await this.visibleRaffle(id);
    if (!raffle) this.notFound();
    return this.view(raffle);
  }

  async latest() {
    const raffle = await this.dataSource.getRepository(Raffle).findOne({
      where: { status: In(PUBLIC_RAFFLE_STATUSES) },
      select: this.publicSelect(),
      order: { createdAt: "DESC" },
    });
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "Todavía no publicamos ninguna rifa.",
      });
    return this.view(raffle);
  }

  async numbers(id: string) {
    const raffle = await this.visibleRaffle(id);
    if (!raffle) this.notFound();
    const numbers = await this.dataSource.getRepository(RaffleNumber).find({
      where: { raffleId: id },
      select: { number: true, status: true },
      order: { number: "ASC" },
    });
    return {
      raffleId: raffle.id,
      status: raffle.status,
      numbers: numbers.map((item) => ({
        number: item.number,
        status: item.status,
      })),
    };
  }

  private visibleRaffle(id: string) {
    return this.dataSource.getRepository(Raffle).findOne({
      where: { id, status: In(PUBLIC_RAFFLE_STATUSES) },
      select: this.publicSelect(),
    });
  }

  private async view(raffle: Raffle) {
    const stats = await this.numberStats(raffle.id);
    return {
      id: raffle.id,
      title: raffle.title,
      prizeName: raffle.prizeName,
      description: raffle.description,
      imageUrls: raffle.imageUrls,
      imageUrl: raffle.imageUrls[0] ?? null,
      priceInCents: raffle.priceInCents,
      status: raffle.status,
      drawAt: raffle.drawAt,
      stats,
      ...(raffle.status === RaffleStatus.DRAWN
        ? {
            winningNumber: raffle.winningNumber,
            drawnAt: raffle.drawnAt,
          }
        : {}),
    };
  }

  private async numberStats(raffleId: string) {
    const row = await this.dataSource
      .getRepository(RaffleNumber)
      .createQueryBuilder("number")
      .select("COUNT(*)", "total")
      .addSelect(
        "COUNT(*) FILTER (WHERE number.status = :available)",
        "available",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE number.status = :reserved)",
        "reserved",
      )
      .addSelect("COUNT(*) FILTER (WHERE number.status = :sold)", "sold")
      .where("number.raffleId = :raffleId", { raffleId })
      .setParameters({
        available: RaffleNumberStatus.AVAILABLE,
        reserved: RaffleNumberStatus.RESERVED,
        sold: RaffleNumberStatus.SOLD,
      })
      .getRawOne<PublicNumberStatsRow>();
    return {
      available: Number(row?.available ?? 0),
      reserved: Number(row?.reserved ?? 0),
      sold: Number(row?.sold ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  private publicSelect() {
    return {
      id: true,
      title: true,
      prizeName: true,
      description: true,
      imageUrls: true,
      priceInCents: true,
      status: true,
      drawAt: true,
      winningNumber: true,
      drawnAt: true,
    } as const;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: "RAFFLE_NOT_FOUND",
      message: "La rifa no existe.",
    });
  }
}
