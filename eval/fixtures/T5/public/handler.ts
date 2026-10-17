export async function getInvoice(db: any, tenantId: string, invoiceId: string) {
  return db.invoice.findUnique({ where: { id: invoiceId } });
}
