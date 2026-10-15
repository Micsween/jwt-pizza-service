const express = require("express");
const { asyncHandler } = require("../endpointHelper.js");
const { DB, Role } = require("../database/database.js");
const { authRouter, setAuth } = require("./authRouter.js");

const userRouter = express.Router();

userRouter.docs = [
  {
    method: "GET",
    path: "/api/user?page=1&limit=10&name=*",
    requiresAuth: true,
    description: "Gets a list of users",
    example: `curl -X GET localhost:3000/api/user -H 'Authorization: Bearer tttttt'`,
    response: {
      users: [
        {
          id: 1,
          name: "常用名字",
          email: "a@jwt.com",
          roles: [{ role: "admin" }],
        },
      ],
    },
  },
  {
    method: "GET",
    path: "/api/user/me",
    requiresAuth: true,
    description: "Get authenticated user",
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: {
      id: 1,
      name: "常用名字",
      email: "a@jwt.com",
      roles: [{ role: "admin" }],
    },
  },
  {
    method: "PUT",
    path: "/api/user/:userId",
    requiresAuth: true,
    description: "Update user",
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字", "email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: {
      user: {
        id: 1,
        name: "常用名字",
        email: "a@jwt.com",
        roles: [{ role: "admin" }],
      },
      token: "tttttt",
    },
  },
  {
    method: "DELETE",
    path: "/api/user/:userId",
    requiresAuth: true,
    description: "Delete user",
    example: `curl -X DELETE localhost:3000/api/user/1 -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: {
      deleted: true,
    },
  },
];

// getUser
userRouter.get(
  "/me",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  }),
);

// updateUser
userRouter.put(
  "/:userId",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const userId = Number(req.params.userId);
    const user = req.user;
    if (user.id !== userId && !user.isRole(Role.Admin)) {
      return res.status(403).json({ message: "unauthorized" });
    }

    const updatedUser = await DB.updateUser(userId, name, email, password);
    const auth = await setAuth(updatedUser);
    res.json({ user: updatedUser, token: auth });
  }),
);

// deleteUser
userRouter.delete(
  "/:userId",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const userId = Number(req.params.userId);
    if (!user.isRole(Role.Admin)) {
      return res.status(403).json({ message: "unauthorized" });
    }
    const deletedUser = await DB.deleteUser(userId);
    res.json({ deleted: deletedUser });
  }),
);

//As an admin I can see a list of all users. Each user's name, email, and role is displayed. The list is paginated. The list can be filtered by user name.
///api/user?page=1&limit=10&name=*
userRouter.get(
  "/",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const name = req.query.name;
    //the assumption here is that there are default page numbers and a user can never ask for page NAN or not ask for a page
    const page = Number(req.query.page);
    const limit = Number(req.query.limit);
    if (!user.isRole(Role.Admin)) {
      return res.status(403).json({ message: "unauthorized" });
    }
    const users_more = await DB.getUsers(page, limit, name);
    res.json(users_more);
  }),
);

module.exports = userRouter;
