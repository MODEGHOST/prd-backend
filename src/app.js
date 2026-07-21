import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Server } from "socket.io";
import { config } from "./core/config.js";
import {
  canAssignCompanyRole,
  canManageMembership,
  companyRoleRank,
  hasPermission,
  isHierarchyPermission,
  isRequesterPersona,
} from "./core/authz.js";
import { getRuntimeMetrics, logger, requestContext } from "./core/logger.js";
import { enqueueOutbox } from "./core/outbox.js";
import {
  clearSessionCookie,
  setSessionCookie,
} from "./core/session-cookie.js";
import { wrap } from "./middleware/async-handler.js";
import { createAuth } from "./middleware/auth.js";
import { createAuthRateLimit } from "./middleware/auth-rate-limit.js";
import { createProjectRepository, STAFF_MEMBERSHIP_SQL } from "./repositories/projects.js";
import { createIssueRepository } from "./repositories/issues.js";
import { createUserRepository } from "./repositories/users.js";
import { registerSocketHandlers } from "./realtime/socket-handlers.js";
import { registerOperationalRoutes } from "./routes/operational.js";
import { registerPublicAuthRoutes } from "./routes/public-auth.js";
import { registerCompanyMembershipRoutes } from "./routes/company-membership.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { createAuditService } from "./services/audit.js";
import { createEmailService, createOneTimeToken } from "./services/communications.js";
import { createNotificationService } from "./services/notifications.js";
import { createProjectIssueSyncService } from "./services/project-issue-sync.js";
import {
  normalizeBudget,
  normalizeCurrency,
  paginatedJson,
  parsePagination,
  toDateOnly,
  uniquePositiveIds,
} from "./validators/common.js";

export function createApplication(options = {}) {
  let ready = false;
  const getReady = options.getReady || (() => ready);
  const setReady = options.setReady || ((value) => {
    ready = value;
  });

  const app = express();
  app.set("trust proxy", config.trustProxy);
  const server = createServer(app);
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    dateStrings: true,
  });
  const io = new Server(server, {
    cors: {
      origin: [config.frontendUrl, "http://127.0.0.1:5173"],
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      credentials: true,
    },
    transports: ["polling", "websocket"],
  });

  app.use(helmet());
  app.use(cors({
    origin: [config.frontendUrl, "http://127.0.0.1:5173"],
    credentials: true,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(requestContext);

  const {
    auth,
    loadSession,
    requireCompanyManager,
    requirePermission,
    sign,
    invalidateSessionCache,
  } = createAuth({
    pool,
    jwtSecret: config.jwtSecret,
    authTokenTtl: config.authTokenTtl,
  });
  const { authRateCleanupTimer, authRateLimit, closeAuthRateLimit } = createAuthRateLimit({
    redisUrl: config.redisUrl,
    logger,
  });
  const sendEmail = createEmailService({
    config,
    emailFrom: config.emailFrom,
    logger,
  });
  const audit = createAuditService(pool);

  const {
    canAccessProject,
    canManageProject,
    getProjectById,
    getProjectRecipientIds,
    isProjectMember,
    isProjectStaffMember,
  } = createProjectRepository(pool);
  const {
    canViewIssue,
    getIssueById,
    getIssueRecipientIds,
    isIssueParticipant,
  } = createIssueRepository(pool);
  const { usersExist } = createUserRepository(pool);

  const {
    drainBackgroundJobs,
    notify,
    notifyIssueRecipients,
    notifyIssueRecipientsLater,
    notifyLater,
    notifyProjectRecipients,
    notifyProjectRecipientsLater,
  } = createNotificationService({
    pool,
    logger,
    enqueueOutbox,
    getIssueRecipientIds,
    getProjectRecipientIds,
  });

  const {
    addIssueActivity,
    countIncompleteSiblingTasks,
    ensureIssueMember,
    ensureLinkedIssueTask,
    ensureProjectMember,
    getProjectBoardGate,
    getTicketCompletionBlockReason,
    issueStateForTaskStatus,
    syncIssueMembersFromProject,
    syncSingleLinkedTask,
  } = createProjectIssueSyncService();

  registerSocketHandlers({
    io,
    loadSession,
    canAccessProject,
    getIssueById,
    canViewIssue,
  });

  registerOperationalRoutes(app, {
    config,
    getReady,
    getRuntimeMetrics,
    logger,
    pool,
  });

  registerPublicAuthRoutes(app, {
    audit,
    auth,
    authRateLimit,
    bcrypt,
    clearSessionCookie,
    config,
    createHash,
    createOneTimeToken,
    enqueueOutbox,
    frontendUrl: config.frontendUrl,
    invalidateSessionCache,
    jwt,
    jwtSecret: config.jwtSecret,
    loadSession,
    notifyLater,
    pool,
    requirePermission,
    setSessionCookie,
    sign,
    wrap,
  });

  registerCompanyMembershipRoutes(app, {
    audit,
    auth,
    canAssignCompanyRole,
    canManageMembership,
    companyRoleRank,
    hasPermission,
    invalidateSessionCache,
    isHierarchyPermission,
    isRequesterPersona,
    paginatedJson,
    parsePagination,
    pool,
    randomBytes,
    requireCompanyManager,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    wrap,
  });

  registerInvitationRoutes(app, {
    audit,
    auth,
    canAssignCompanyRole,
    createHash,
    createOneTimeToken,
    enqueueOutbox,
    frontendUrl: config.frontendUrl,
    pool,
    requirePermission,
    wrap,
  });

  registerDashboardRoutes(app, {
    auth,
    hasPermission,
    isRequesterPersona,
    paginatedJson,
    parsePagination,
    pool,
    wrap,
  });

  registerProjectRoutes(app, {
    audit,
    auth,
    canAccessProject,
    canManageProject,
    config,
    ensureProjectMember,
    getProjectBoardGate,
    getProjectById,
    hasPermission,
    io,
    isProjectStaffMember,
    isRequesterPersona,
    normalizeBudget,
    normalizeCurrency,
    notify,
    notifyProjectRecipientsLater,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    syncIssueMembersFromProject,
    toDateOnly,
    uniquePositiveIds,
    usersExist,
    wrap,
  });

  registerIssueRoutes(app, {
    addIssueActivity,
    auth,
    canAccessProject,
    canViewIssue,
    config,
    ensureIssueMember,
    ensureLinkedIssueTask,
    ensureProjectMember,
    getIssueById,
    getTicketCompletionBlockReason,
    hasPermission,
    io,
    isIssueParticipant,
    isRequesterPersona,
    issueStateForTaskStatus,
    normalizeBudget,
    normalizeCurrency,
    notify,
    notifyIssueRecipients,
    notifyIssueRecipientsLater,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    syncIssueMembersFromProject,
    syncSingleLinkedTask,
    uniquePositiveIds,
    usersExist,
    wrap,
  });

  registerTaskRoutes(app, {
    addIssueActivity,
    auth,
    canAccessProject,
    canManageProject,
    countIncompleteSiblingTasks,
    getIssueById,
    getProjectBoardGate,
    hasPermission,
    isIssueParticipant,
    isProjectMember,
    isProjectStaffMember,
    isRequesterPersona,
    issueStateForTaskStatus,
    notify,
    notifyIssueRecipients,
    paginatedJson,
    parsePagination,
    pool,
    requirePermission,
    STAFF_MEMBERSHIP_SQL,
    wrap,
  });

  registerNotificationRoutes(app, {
    auth,
    isRequesterPersona,
    parsePagination,
    pool,
    wrap,
  });

  app.use((err, req, res, _next) => {
    logger.error("http.request.failed", err, {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      userId: req.user?.id,
      companyId: req.user?.companyId,
    });
    if (err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FILE_COUNT") {
      return res.status(413).json({ message: "ไฟล์มีขนาดหรือจำนวนเกินที่กำหนด" });
    }
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "ข้อมูลนี้มีอยู่ในระบบแล้ว" });
    }
    res.status(500).json({ message: "เกิดข้อผิดพลาดภายในระบบ" });
  });

  return {
    app,
    authRateCleanupTimer,
    closeAuthRateLimit,
    drainBackgroundJobs,
    getReady,
    io,
    pool,
    sendEmail,
    server,
    setReady,
  };
}
