import { Router } from "express";
import { AuthController } from "./auth.controller";

const router = Router();

// Public routes
router.post("/register", AuthController.register);
router.post("/login", AuthController.login);
router.get("/refresh", AuthController.refreshToken);
router.post("/logout", AuthController.logout);



export default router;