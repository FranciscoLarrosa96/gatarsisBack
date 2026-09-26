import { Injectable, NotFoundException } from "@nestjs/common";
import ExcelJS = require("exceljs");
import PDFDocument = require("pdfkit");
import { DataSource } from "typeorm";
import { DomainError } from "../common/domain-error";
import { OrderPaymentSource } from "../orders/entities/order.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "./entities/raffle-number.entity";
import { Raffle } from "./entities/raffle.entity";
import { isEligibleRaffleParticipant } from "./raffle-participant-eligibility";

type Participant = {
  number: number;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  paymentSource: OrderPaymentSource;
  amountInCents: number;
  paidAt: Date | null;
  soldAt: Date | null;
  purchaseId: string;
  orderId: string;
};

export type RaffleExport = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

@Injectable()
export class RaffleExportsService {
  constructor(private readonly dataSource: DataSource) {}

  async excel(raffleId: string): Promise<RaffleExport> {
    const { raffle, participants, summary } = await this.exportData(raffleId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Gatarsis";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Participantes", {
      views: [{ state: "frozen", ySplit: 12 }],
    });
    sheet.mergeCells("A1:J1");
    sheet.getCell("A1").value = "GATARSIS";
    sheet.getCell("A1").font = {
      bold: true,
      size: 18,
      color: { argb: "FFFF2E93" },
    };
    sheet.mergeCells("A2:J2");
    sheet.getCell("A2").value = raffle.title;
    sheet.getCell("A2").font = { bold: true, size: 14 };
    sheet.getCell("A3").value = "Premio";
    sheet.getCell("B3").value = raffle.prizeName;
    sheet.getCell("A4").value = "Estado";
    sheet.getCell("B4").value = raffle.status;
    sheet.getCell("A5").value = "Precio por número";
    sheet.getCell("B5").value = raffle.priceInCents / 100;
    sheet.getCell("B5").numFmt = '"$" #,##0.00';
    sheet.getCell("A6").value = "Generado";
    sheet.getCell("B6").value = this.formatDate(new Date());
    sheet.getCell("A7").value = "Vendidos / participantes pagos";
    sheet.getCell("B7").value = participants.length;
    sheet.getCell("A8").value = "Reservados";
    sheet.getCell("B8").value = summary.reserved;
    sheet.getCell("A9").value = "Disponibles";
    sheet.getCell("B9").value = summary.available;
    sheet.getCell("A10").value = "Recaudado confirmado";
    sheet.getCell("B10").value =
      participants.reduce((sum, item) => sum + item.amountInCents, 0) / 100;
    sheet.getCell("B10").numFmt = '"$" #,##0.00';

    const headers = [
      "Número",
      "Estado del número",
      "Comprador",
      "Email",
      "Teléfono",
      "Estado del pago",
      "Origen",
      "Importe",
      "Fecha",
      "Purchase ID / Order ID",
    ];
    const headerRow = sheet.getRow(12);
    headerRow.values = headers;
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF252218" },
    };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 24;

    for (const participant of participants) {
      const row = sheet.addRow([
        this.formatNumber(participant.number),
        "VENDIDO",
        participant.buyerName,
        participant.buyerEmail ?? "",
        participant.buyerPhone ?? "",
        "PAGADO",
        participant.paymentSource === OrderPaymentSource.MANUAL
          ? "Manual"
          : "Online",
        participant.amountInCents / 100,
        this.formatDate(participant.paidAt ?? participant.soldAt),
        `${participant.purchaseId} / ${participant.orderId}`,
      ]);
      row.getCell(8).numFmt = '"$" #,##0.00';
    }
    [10, 20, 28, 34, 20, 20, 14, 16, 22, 78].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.autoFilter = { from: "A12", to: `J${12 + participants.length}` };

    const output = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(output),
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `gatarsis-${this.slug(raffle.title)}-participantes.xlsx`,
    };
  }

  async pdf(raffleId: string): Promise<RaffleExport> {
    const { raffle, participants } = await this.exportData(raffleId);
    const chunks: Buffer[] = [];
    const document = new PDFDocument({
      size: "A4",
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      bufferPages: true,
      compress: false,
      info: { Title: `Participantes - ${raffle.title}`, Author: "Gatarsis" },
    });
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    const completed = new Promise<Buffer>((resolve, reject) => {
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
    });

    const tableHeader = () => {
      document.font("Helvetica-Bold").fontSize(10);
      document.text("Número", 50, document.y, { width: 65 });
      document.text("Participante", 125, document.y - 12, { width: 410 });
      document.moveDown(0.5);
      document.moveTo(50, document.y).lineTo(545, document.y).stroke("#777777");
      document.moveDown(0.5);
      document.font("Helvetica");
    };

    document
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#e91e78")
      .text("GATARSIS");
    document.fillColor("#111111").fontSize(15).text(raffle.title);
    document.font("Helvetica").fontSize(11).text(`Premio: ${raffle.prizeName}`);
    document.moveDown(0.8);
    document
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("Listado de participantes");
    document
      .font("Helvetica")
      .fontSize(10)
      .text(`Generado: ${this.formatDate(new Date())}`);
    document.text(`Total de números participantes: ${participants.length}`);
    document.moveDown();
    tableHeader();

    for (const participant of participants) {
      if (document.y > 760) {
        document.addPage();
        tableHeader();
      }
      const y = document.y;
      document
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(this.formatNumber(participant.number), 50, y, {
          width: 65,
        });
      document
        .font("Helvetica")
        .text(participant.buyerName, 125, y, { width: 410 });
      document.y = Math.max(document.y, y + 18);
    }

    const range = document.bufferedPageRange();
    for (
      let index = range.start;
      index < range.start + range.count;
      index += 1
    ) {
      document.switchToPage(index);
      document
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#666666")
        .text(`Página ${index - range.start + 1} de ${range.count}`, 48, 780, {
          width: 499,
          align: "center",
          lineBreak: false,
        });
    }
    document.end();

    return {
      buffer: await completed,
      contentType: "application/pdf",
      filename: `gatarsis-${this.slug(raffle.title)}-participantes.pdf`,
    };
  }

  private async exportData(raffleId: string) {
    const raffle = await this.dataSource
      .getRepository(Raffle)
      .findOneBy({ id: raffleId });
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "La rifa no existe.",
      });

    const numbers = await this.dataSource.getRepository(RaffleNumber).find({
      where: { raffleId },
      relations: { rafflePurchase: { order: true } },
      order: { number: "ASC" },
    });
    const participants: Participant[] = numbers
      .filter(
        (number) =>
          number.rafflePurchase?.order &&
          isEligibleRaffleParticipant(number, number.rafflePurchase.order),
      )
      .map((number) => {
        const purchase = number.rafflePurchase!;
        const order = purchase.order;
        return {
          number: number.number,
          buyerName: purchase.buyerName,
          buyerEmail: purchase.buyerEmail,
          buyerPhone: purchase.buyerPhone,
          paymentSource: order.paymentSource,
          amountInCents: purchase.unitPriceInCents,
          paidAt: order.paidAt,
          soldAt: number.soldAt,
          purchaseId: purchase.id,
          orderId: order.id,
        };
      });
    if (!participants.length)
      throw new DomainError(
        "RAFFLE_PARTICIPANTS_NOT_AVAILABLE",
        "Todavía no hay participantes pagos para exportar.",
        undefined,
        409,
      );
    return {
      raffle,
      participants,
      summary: {
        available: numbers.filter(
          (number) => number.status === RaffleNumberStatus.AVAILABLE,
        ).length,
        reserved: numbers.filter(
          (number) => number.status === RaffleNumberStatus.RESERVED,
        ).length,
      },
    };
  }

  private formatDate(value: Date | null): string {
    if (!value) return "";
    return new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      dateStyle: "short",
      timeStyle: "short",
    }).format(value);
  }

  private formatNumber(value: number): string {
    return String(value).padStart(2, "0");
  }

  private slug(value: string): string {
    return (
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "rifa"
    );
  }
}
