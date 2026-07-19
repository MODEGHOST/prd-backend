export function registerSocketHandlers({
  io,
  loadSession,
  canAccessProject,
  getIssueById,
  canViewIssue,
}) {
  io.on("connection", (socket) => {
    const sessionForSocket = async (token) => {
      const user = await loadSession(token);
      if (socket.data.userId
          && (Number(socket.data.userId) !== Number(user.id)
            || Number(socket.data.companyId) !== Number(user.companyId))) {
        throw new Error("socket identity changed");
      }
      socket.data.userId = user.id;
      socket.data.companyId = user.companyId;
      return user;
    };

    socket.on("join", async (token) => {
      try {
        const user = await sessionForSocket(token);
        socket.join(`company:${user.companyId}:user:${user.id}`);
      } catch {
        socket.disconnect();
      }
    });

    socket.on("joinProject", async (payload) => {
      try {
        const token = payload?.token;
        const projectId = Number(payload?.projectId);
        if (!token || !Number.isInteger(projectId) || projectId <= 0) {
          socket.emit("projectError", { message: "ข้อมูลเข้าร่วมโครงการไม่ถูกต้อง" });
          return;
        }
        const user = await sessionForSocket(token);
        const access = await canAccessProject(user, projectId);
        if (access === null) {
          socket.emit("projectError", { message: "ไม่พบโครงการ" });
          return;
        }
        if (!access) {
          socket.emit("projectError", { message: "คุณไม่มีสิทธิ์เข้าโครงการนี้" });
          return;
        }
        socket.join(`company:${user.companyId}:project:${projectId}`);
        socket.emit("projectJoined", { projectId });
      } catch {
        socket.emit("projectError", { message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
      }
    });

    socket.on("leaveProject", (payload) => {
      const projectId = Number(payload?.projectId);
      if (Number.isInteger(projectId) && projectId > 0) {
        socket.leave(`company:${socket.data.companyId}:project:${projectId}`);
      }
    });

    socket.on("joinIssue", async (payload) => {
      try {
        const token = payload?.token;
        const issueId = Number(payload?.issueId);
        if (!token || !Number.isInteger(issueId) || issueId <= 0) {
          socket.emit("issueError", { message: "ข้อมูลเข้าร่วม Ticket ไม่ถูกต้อง" });
          return;
        }
        const user = await sessionForSocket(token);
        const issue = await getIssueById(issueId, user.companyId);
        if (!issue) {
          socket.emit("issueError", { message: "ไม่พบ Ticket" });
          return;
        }
        if (!(await canViewIssue(user, issue))) {
          socket.emit("issueError", { message: "คุณไม่มีสิทธิ์ดู Ticket นี้" });
          return;
        }
        socket.join(`company:${user.companyId}:issue:${issueId}`);
        socket.emit("issueJoined", { issueId });
      } catch {
        socket.emit("issueError", { message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
      }
    });

    socket.on("leaveIssue", (payload) => {
      const issueId = Number(payload?.issueId);
      if (Number.isInteger(issueId) && issueId > 0) {
        socket.leave(`company:${socket.data.companyId}:issue:${issueId}`);
      }
    });
  });
}
