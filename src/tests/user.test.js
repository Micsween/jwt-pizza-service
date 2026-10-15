const request = require("supertest");
const app = require("../service");
const { DB, Role } = require("../database/database.js");
const config = require("../config.js");
const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
const testAdmin = { name: "admin", email: "admin@test.com", password: "admin" };

const dbHost = config.db.connection.host;
if (!["127.0.0.1", "localhost"].includes(dbHost)) {
  throw new Error(
    `Refusing to run tests against non-local database host: ${dbHost}`,
  );
  //claude recommended this and I actually think its a great idea
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

let testUserId;
let testAdminAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserId = registerRes.body.user.id;

  testAdmin.email = Math.random().toString(36).substring(2, 12) + "@admin.com";
  await DB.addUser({ ...testAdmin, roles: [{ role: Role.Admin }] });
  const adminRes = await request(app).put("/api/auth").send(testAdmin);
  testAdminAuthToken = adminRes.body.token;
});

//happy path 200
test("delete user", async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUserId}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ deleted: true });

  //the deleted user shouldn't be able to log in anymore
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(404);
  expect(loginRes.body.message).toBe("unknown user");

  //fix it
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserId = registerRes.body.user.id;
});

//bad path 401

test("delete user unauthenticated", async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUserId}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}imabaddie`);

  expect(deleteRes.status).toBe(401);
  expect(deleteRes.body).toEqual({ message: "unauthorized" });

  //the user we tried to delete should still be able to login
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
});

test("list users unauthorized", async () => {
  const listUsersRes = await request(app).get("/api/user");
  expect(listUsersRes.status).toBe(401);
});

//happy path list user with name that exists
test("list users", async () => {
  //a random name so the search can only match the user we just registered
  const uniqueName = randomName();
  const [user] = await registerUser(uniqueName);
  const listUsersRes = await request(app)
    .get(`/api/user?page=1&limit=10&name=${uniqueName}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.users).toEqual([
    {
      email: user.email,
      id: user.id,
      name: uniqueName,
      roles: [{ role: Role.Diner }],
    },
  ]);
  expect(listUsersRes.body.more).toBe(false);
  //delete the user we just made
  await request(app)
    .delete(`/api/user/${uniqueName}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
});

//happy path default page load
test("list users paginates at limit and reports more", async () => {
  //every user shares a random prefix so the wildcard search only matches the users made here
  const prefix = randomName();
  const registered = await Promise.all(
    Array.from({ length: 11 }, (_, i) => registerUser(`${prefix}${i}`)),
  );

  const listUsersRes = await request(app)
    .get(`/api/user?page=1&limit=10&name=${prefix}*`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.users).toHaveLength(10);
  expect(listUsersRes.body.more).toBe(true);

  //delete the users we just made
  for (const [user] of registered) {
    const deleteRes = await request(app)
      .delete(`/api/user/${user.id}`)
      .set("Authorization", `Bearer ${testAdminAuthToken}`);
    expect(deleteRes.status).toBe(200);
  }
});

//happy path but the user doesn't exist
test("list users returns empty when no name matches", async () => {
  //a random name that was never registered, so nothing should match it
  const missingName = randomName();
  const listUsersRes = await request(app)
    .get(`/api/user?page=1&limit=10&name=${missingName}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.users).toEqual([]);
  expect(listUsersRes.body.more).toBe(false);
});

//bad path 401 with an invalid token
test("list users as non-admin", async () => {
  const [user, userToken] = await registerUser(randomName());
  const listUsersRes = await request(app)
    .get(`/api/user?page=1&limit=10&name=*`)
    .set("Authorization", `Bearer ${userToken}imabaddie`);

  expect(listUsersRes.status).toBe(401);
  expect(listUsersRes.body).toEqual({ message: "unauthorized" });

  const deleteRes = await request(app)
    .delete(`/api/user/${user.id}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
  expect(deleteRes.status).toBe(200);
});
//bad path 403 with valid token but not an admin
test("list users forbidden for non-admin", async () => {
  const [user, userToken] = await registerUser(randomName());
  const listUsersRes = await request(app)
    .get(`/api/user?page=1&limit=10&name=*`)
    .set("Authorization", `Bearer ${userToken}`);

  expect(listUsersRes.status).toBe(403);
  expect(listUsersRes.body).toEqual({ message: "unauthorized" });

  const deleteRes = await request(app)
    .delete(`/api/user/${user.id}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);
  expect(deleteRes.status).toBe(200);
});

async function registerUser(name = "pizza diner") {
  const testUser = {
    name,
    email: `${randomName()}@test.com`,
    password: "a",
  };
  const registerRes = await request(app).post("/api/auth").send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}
//Return a list of users
// Handle the pagination of the list
// Handle the name filter
