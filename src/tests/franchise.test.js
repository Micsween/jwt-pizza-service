const request = require("supertest");
const app = require("../service");
const { DB, Role } = require("../database/database.js");
const config = require("../config.js");
const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
const testAdmin = { name: "admin", email: "admin@test.com", password: "admin" };
const testFranchisee = {
  name: "pizza franchisee",
  email: "franchisee@test.com",
  password: "f",
};
let testUserAuthToken;
let testAdminAuthToken;
let testFranchiseeAuthToken;
let testFranchiseeId;
let testFranchise;

const dbHost = config.db.connection.host;
if (!["127.0.0.1", "localhost"].includes(dbHost)) {
  throw new Error(
    `Refusing to run tests against non-local database host: ${dbHost}`,
  );
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

beforeAll(async () => {
  //register a random test user, admin, and franchisee.
  testUser.email = randomName() + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserAuthToken = registerRes.body.token;

  testAdmin.email = randomName() + "@admin.com";
  await DB.addUser({ ...testAdmin, roles: [{ role: Role.Admin }] });
  const adminRes = await request(app).put("/api/auth").send(testAdmin);
  testAdminAuthToken = adminRes.body.token;

  testFranchisee.email = randomName() + "@franchisee.com";
  const franchiseeRes = await request(app)
    .post("/api/auth")
    .send(testFranchisee);
  testFranchiseeAuthToken = franchiseeRes.body.token;
  testFranchiseeId = franchiseeRes.body.user.id;

  //add a franchise thats owned by our test franchisee, so their tests don't break.
  testFranchise = await DB.createFranchise({
    name: "Test Franchise " + randomName(),
    admins: [{ email: testFranchisee.email }],
  });
});

afterAll(async () => {
  //get rid of all the franchise we created.
  await DB.deleteFranchise(testFranchise.id);
});

//happy path 200
test("list franchises", async () => {
  const listRes = await request(app).get(
    `/api/franchise?name=${encodeURIComponent(testFranchise.name)}`,
  );
  //try and list franchises as a general user (anyone can get this. even if they're not logged in. Maybe decide if I'm okay with that lol).

  expect(listRes.status).toBe(200);
  expect(listRes.body.more).toBe(false);
  expect(listRes.body.franchises).toEqual([
    expect.objectContaining({ id: testFranchise.id, name: testFranchise.name }),
  ]);
});

//happy path 200
test("get franchises as a franchisee", async () => {
  const franchiseRes = await request(app)
    .get(`/api/franchise/${testFranchiseeId}`)
    .set("Authorization", `Bearer ${testFranchiseeAuthToken}`);

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual([
    expect.objectContaining({
      id: testFranchise.id,
      admins: [expect.objectContaining({ id: testFranchiseeId })],
    }),
  ]);
});

//bad path, test if youre not a franchisee will it let you see info on their franchise?
test("get someone else's franchises as a diner", async () => {
  const getSpy = jest.spyOn(DB, "getUserFranchises");

  const franchiseRes = await request(app)
    .get(`/api/franchise/${testFranchiseeId}`)
    .set("Authorization", `Bearer ${testUserAuthToken}`);

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual([]);
  //make sure it never hits the database
  expect(getSpy).not.toHaveBeenCalled();
  getSpy.mockRestore();
});

//happy path 200
test("create and delete a franchise as an admin", async () => {
  const newFranchise = {
    name: "New Franchise " + randomName(),
    admins: [{ email: testFranchisee.email }],
  };

  // Create the franchise
  const createRes = await request(app)
    .post("/api/franchise")
    .set("Authorization", `Bearer ${testAdminAuthToken}`)
    .send(newFranchise);

  expect(createRes.status).toBe(200);
  expect(createRes.body).toMatchObject({
    name: newFranchise.name,
    id: expect.any(Number),
    admins: [{ email: testFranchisee.email, id: testFranchiseeId }],
  });

  // Delete the franchise
  const deleteRes = await request(app)
    .delete(`/api/franchise/${createRes.body.id}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe("franchise deleted");

  // it should be gone from the list
  const listRes = await request(app).get(
    `/api/franchise?name=${encodeURIComponent(newFranchise.name)}`,
  );
  expect(listRes.body.franchises).toEqual([]);
});

//bad path 403
test("create a franchise as a non-admin user", async () => {
  const createSpy = jest.spyOn(DB, "createFranchise");

  const createRes = await request(app)
    .post("/api/franchise")
    .set("Authorization", `Bearer ${testUserAuthToken}`)
    .send({ name: "Sneaky Franchise", admins: [{ email: testUser.email }] });

  expect(createRes.status).toBe(403);
  expect(createRes.body.message).toBe("unable to create a franchise");
  // The route should reject before ever touching the database
  expect(createSpy).not.toHaveBeenCalled();
  createSpy.mockRestore();
});

//bad path 401
test("create a franchise without logging in", async () => {
  const createRes = await request(app)
    .post("/api/franchise")
    .send({ name: "Anonymous Franchise", admins: [] });

  expect(createRes.status).toBe(401);
  expect(createRes.body.message).toBe("unauthorized");
});

//happy path 200
test("create and delete a store as a franchisee", async () => {
  const newStore = { name: "Store " + randomName() };

  // Create the store
  const storeRes = await request(app)
    .post(`/api/franchise/${testFranchise.id}/store`)
    .set("Authorization", `Bearer ${testFranchiseeAuthToken}`)
    .send(newStore);

  expect(storeRes.status).toBe(200);
  expect(storeRes.body).toMatchObject({
    ...newStore,
    franchiseId: testFranchise.id,
    id: expect.any(Number),
  });

  // Delete the store
  const deleteRes = await request(app)
    .delete(`/api/franchise/${testFranchise.id}/store/${storeRes.body.id}`)
    .set("Authorization", `Bearer ${testFranchiseeAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe("store deleted");

  // the store should no longer show up on the franchise
  const franchiseRes = await request(app)
    .get(`/api/franchise/${testFranchiseeId}`)
    .set("Authorization", `Bearer ${testFranchiseeAuthToken}`);
  expect(franchiseRes.body[0].stores).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: storeRes.body.id })]),
  );
});

//bad path 403
test("create a store as a non-admin user", async () => {
  const storeSpy = jest.spyOn(DB, "createStore");

  const storeRes = await request(app)
    .post(`/api/franchise/${testFranchise.id}/store`)
    .set("Authorization", `Bearer ${testUserAuthToken}`)
    .send({ name: "Sneaky Store" });

  expect(storeRes.status).toBe(403);
  expect(storeRes.body.message).toBe("unable to create a store");
  expect(storeSpy).not.toHaveBeenCalled();
  storeSpy.mockRestore();
});

//bad path 403
test("delete a store as a non-admin user", async () => {
  const deleteSpy = jest.spyOn(DB, "deleteStore");

  const deleteRes = await request(app)
    .delete(`/api/franchise/${testFranchise.id}/store/1`)
    .set("Authorization", `Bearer ${testUserAuthToken}`);

  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body.message).toBe("unable to delete a store");
  expect(deleteSpy).not.toHaveBeenCalled();
  deleteSpy.mockRestore();
});
