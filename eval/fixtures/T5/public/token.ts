export function authorize(claims: any, required: string) {
  return claims.permissions.includes(required) || claims.permissions.includes('*');
}
