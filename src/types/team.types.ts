export interface ITeam {
  id: string;
  name: string;
  description?: string;
  teamLeadId: string;
  createdBy: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Optional field for joined data
  members?: string[]; 
}