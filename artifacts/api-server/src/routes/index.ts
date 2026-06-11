import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gatewayRouter from "./gateway";
import authRouter from "./auth";
import apiKeysRouter from "./apikeys";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(apiKeysRouter);
router.use(gatewayRouter);

export default router;
