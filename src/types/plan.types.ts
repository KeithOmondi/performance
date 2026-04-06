export interface IActivity {
  id: string;
  objective_id: string;
  description: string;
}

export interface IObjective {
  id: string;
  plan_id: string;
  title: string;
  activities?: IActivity[];
}

export interface IStrategicPlan {
  id: string;
  perspective: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  objectives?: IObjective[];
}