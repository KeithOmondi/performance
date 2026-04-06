export type RegistryQuarter = 0 | 1 | 2 | 3 | 4;

export interface IRegistryConfiguration {
  id: string;
  quarter: RegistryQuarter;
  year: number;
  startDate: Date;
  endDate: Date;
  isLocked: boolean;
  lockedReason?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}