export { normalizePath, HttpMethodMiddleware, Get, Post, Put, Delete, Patch } from '../middlewares/HttpMethodMiddleware';
export { ValidateMiddleware, Validate } from '../middlewares/ValidateMiddleware';
export { TransformerMiddleware, Transform } from '../middlewares/TransformerMiddleware';
export { ControllerMiddleware, Controller } from '../middlewares/ControllerMiddleware';
export { ConnectMiddleware, Connect } from '../middlewares/ConnectMiddleware';

import { HttpMethodMiddleware } from '../middlewares/HttpMethodMiddleware';
import { TrackMiddleware } from '../middlewares/TrackMiddleware';
import { ValidateMiddleware } from '../middlewares/ValidateMiddleware';
import { TransformerMiddleware } from '../middlewares/TransformerMiddleware';
import { ConnectMiddleware } from '../middlewares/ConnectMiddleware';

/** Union of all middleware types that can be passed to router.endpoint() / route registration helpers. */
export type EndpointMiddleware = HttpMethodMiddleware | ValidateMiddleware | TransformerMiddleware | TrackMiddleware | ConnectMiddleware;