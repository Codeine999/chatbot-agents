export type BusinessRelation = 'fashion' | 'restaurant' | 'hotel';
export type BusinessProfile = Readonly<{
  type: string;
  relation: BusinessRelation | null;
  columns: Readonly<Record<string, string>>;
}>;
