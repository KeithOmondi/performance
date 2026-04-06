export type UserRole = "user" | "admin" | "superadmin" | "examiner";
export type ReportingCycle = "Quarterly" | "Annual";
export type FileType = "image" | "video" | "raw";
export type ReviewStatus = "Pending" | "Verified" | "Accepted" | "Rejected";
export type AssignmentType = "User" | "Team";
export type IndicatorStatus = 
  | "Pending" 
  | "Awaiting Admin Approval" 
  | "Rejected by Admin" 
  | "Awaiting Super Admin" 
  | "Rejected by Super Admin" 
  | "Completed";

export interface ISubmissionDocument {
  id: string;
  submissionId: string;
  evidenceUrl: string;
  evidencePublicId: string;
  fileType: FileType;
  fileName?: string;
  uploadedAt: Date;
}

export interface ISubmission {
  id: string;
  indicatorId: string;
  quarter: 1 | 2 | 3 | 4;
  notes: string;
  adminDescriptionEdit?: string;
  submittedAt: Date;
  achievedValue: number;
  isReviewed: boolean;
  reviewStatus: ReviewStatus;
  adminComment?: string;
  resubmissionCount: number;
  documents?: ISubmissionDocument[]; // Joined data
}

export interface IReviewHistory {
  id: string;
  indicatorId: string;
  action: string;
  reason?: string;
  reviewerRole: UserRole;
  reviewedBy: string;
  at: Date;
  nextDeadline?: Date;
}

export interface IIndicator {
  id: string;
  strategicPlanId: string;
  objectiveId: string;
  activityId: string;
  assigneeId: string;
  assignmentType: AssignmentType;
  reportingCycle: ReportingCycle;
  target: number;
  weight: number;
  unit: string;
  deadline: Date;
  currentTotalAchieved: number;
  progress: number;
  activeQuarter: 1 | 2 | 3 | 4;
  instructions?: string;
  assignedBy: string;
  status: IndicatorStatus;
  adminOverallComments?: string;
  createdAt: Date;
  updatedAt: Date;
  // Nested Data for API responses
  submissions?: ISubmission[];
  reviewHistory?: IReviewHistory[];
}