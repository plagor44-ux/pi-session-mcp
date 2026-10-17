export async function getTenantInvoice(db: any, tenantId: string, invoiceId: string) {
  return db.invoice.findFirst({ where: { id: invoiceId, tenantId } });
}

export function authorizeExact(claims: { permissions: readonly string[] }, required: string) {
  return claims.permissions.includes(required);
}
