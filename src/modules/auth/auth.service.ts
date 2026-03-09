import { User, IUser, UserRole } from "../user/user.model";
import { AppError } from "../../utils/AppError";

interface ILoginPayload { email: string; password: string; }
interface IRegisterPayload { name: string; email: string; password: string; role?: UserRole; }

export class AuthService {
  static async register(payload: IRegisterPayload): Promise<IUser> {
    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) throw new AppError("Email already in use", 400);

    return await User.create({
      name: payload.name,
      email: payload.email,
      password: payload.password,
      role: payload.role || "user",
    });
  }

  static async login({ email, password }: ILoginPayload) {
    // Select password for comparison
    const user = await User.findOne({ email }).select("+password");
    if (!user) throw new AppError("Invalid email or password", 401);

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new AppError("Invalid email or password", 401);

    return { user };
  }

  static async getUserById(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError("User not found", 404);
    return user;
  }
}