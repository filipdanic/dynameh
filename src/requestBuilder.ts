import * as aws from "aws-sdk";
import {TableSchema} from "./TableSchema";
import {
    checkSchema,
    checkSchemaItemAgreement,
    checkSchemaItemsAgreement,
    checkSchemaKeyAgreement,
    checkSchemaKeysAgreement,
    DynamoKey,
    DynamoKeyPair
} from "./validation";

/**
 * Build a serialized item that can be put in DynamoDB.
 * @param tableSchema
 * @param item
 * @returns a put item
 */
export function buildRequestPutItem(tableSchema: TableSchema, item: any): aws.DynamoDB.AttributeValue {
    switch (typeof item) {
        case "boolean":
            return {BOOL: item};
        case "string":
            return {S: item};
        case "number":
            return {N: item.toString()};
        case "undefined":
        case "object": {
            if (!item) {
                return {NULL: true};
            } else if (item instanceof Buffer) {
                return {B: item.toString("base64")};
            } else if (item instanceof Uint8Array) {
                return {B: Buffer.from(item as any).toString("base64")};
            } else if (item instanceof Date) {
                if (tableSchema.dateSerializationFunction) {
                    return buildRequestPutItem(tableSchema, tableSchema.dateSerializationFunction(item));
                } else {
                    return {S: item.toISOString()};
                }
            } else if (Array.isArray(item)) {
                if (item.length > 0) {
                    const firstItemType = typeof item[0];
                    if (firstItemType === "string" && item.every(x => typeof x === "string")) {
                        return {SS: item.map(s => s.toString())};
                    }
                    if (firstItemType === "number" && item.every(x => typeof x === "number")) {
                        return {NS: item.map(n => n.toString())};
                    }
                    if (firstItemType === "object" && item.every(x => x instanceof Buffer)) {
                        return {BS: item.map(b => b.toString("base64"))};
                    }
                    if (firstItemType === "object" && item.every(x => x instanceof Uint8Array)) {
                        return {BS: item.map(b => Buffer.from(b).toString("base64"))};
                    }
                }
                return {L: item.map(i => buildRequestPutItem(tableSchema, i))};
            } else {
                const valueMap: any = {};
                Object.keys(item).forEach(key => valueMap[key] = buildRequestPutItem(tableSchema, item[key]));
                return {M: valueMap};
            }
        }
        default:
            // "symbol", "function"
            throw new Error(`Type ${typeof item} cannot be serialized into a request object.`);
    }
}

/**
 * Build a request object that can be passed into `getItem`.
 * @param tableSchema
 * @param primaryKeyValue the key of the item to get
 * @param sortKeyValue sort key of the item to get, if set in the schema
 * @returns input for the `getItem` method
 */
export function buildGetInput(tableSchema: TableSchema, primaryKeyValue: DynamoKey, sortKeyValue?: DynamoKey): aws.DynamoDB.Types.GetItemInput {
    checkSchema(tableSchema);
    checkSchemaKeyAgreement(tableSchema, primaryKeyValue, sortKeyValue);

    const request: aws.DynamoDB.Types.GetItemInput = {
        Key: {
            [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, primaryKeyValue)
        },
        TableName: tableSchema.tableName
    };

    if (sortKeyValue) {
        request.Key[tableSchema.sortKeyField] = buildRequestPutItem(tableSchema, sortKeyValue);
    }

    return request;
}

/**
 * Build a request object that can be passed into `putItem`.
 * @param tableSchema
 * @param item
 * @returns input for the `putItem` method
 */
export function buildPutInput(tableSchema: TableSchema, item: Object): aws.DynamoDB.Types.PutItemInput {
    checkSchema(tableSchema);
    checkSchemaItemAgreement(tableSchema, item);

    const request: aws.DynamoDB.Types.PutItemInput = {
        Item: buildRequestPutItem(tableSchema, item).M,
        TableName: tableSchema.tableName
    };

    if (tableSchema.versionKeyField) {
        if (item[tableSchema.versionKeyField] !== null && item[tableSchema.versionKeyField] !== undefined) {
            // Require the existing table item to have the same old value, and increment
            // the value we're putting.  This is the crux of the optimistic locking.
            request.ExpressionAttributeNames = {
                "#V": tableSchema.versionKeyField
            };
            request.ExpressionAttributeValues = {
                ":v": {
                    N: request.Item[tableSchema.versionKeyField].N
                }
            };
            request.ConditionExpression = `#V = :v`;
            request.Item[tableSchema.versionKeyField] = {
                N: (parseInt(request.Item[tableSchema.versionKeyField].N, 10) + 1).toString()
            };
        } else {
            // If the version key isn't set then we must be putting a brand new item,
            // or versioning has just been enabled.
            request.ExpressionAttributeNames = {
                "#V": tableSchema.versionKeyField
            };
            request.ConditionExpression = "attribute_not_exists(#V)";
            request.Item[tableSchema.versionKeyField] = {
                N: "1"
            };
        }
    }

    return request;
}

/**
 * Build a request object that can be passed into `deleteItem`
 * @param tableSchema
 * @param primaryKeyValue the key of the item to delete
 * @param sortKeyValue sort key of the item to delete, if set in the schema
 * @returns input for the `deleteItem` method
 */
export function buildDeleteInput(tableSchema: TableSchema, primaryKeyValue: DynamoKey, sortKeyValue?: DynamoKey): aws.DynamoDB.Types.DeleteItemInput {
    checkSchema(tableSchema);
    checkSchemaKeyAgreement(tableSchema, primaryKeyValue, sortKeyValue);

    const request: aws.DynamoDB.Types.DeleteItemInput = {
        Key: {
            [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, primaryKeyValue)
        },
        TableName: tableSchema.tableName
    };

    if (sortKeyValue) {
        request.Key[tableSchema.sortKeyField] = buildRequestPutItem(tableSchema, sortKeyValue);
    }

    return request;
}

/**
 * Build a request object that can be passed into `batchWriteItem`.
 * @param tableSchema
 * @param items the items to put
 * @returns input for the `batchWriteItem` method
 */
export function buildBatchPutInput(tableSchema: TableSchema, items: Object[]): aws.DynamoDB.Types.BatchWriteItemInput {
    checkSchema(tableSchema);
    checkSchemaItemsAgreement(tableSchema, items);

    if (tableSchema.versionKeyField) {
        throw new Error("TableSchema defines a versionKeyField.  Optimistic locking can not be supported in this request.");
    }

    return {
        RequestItems: {
            [tableSchema.tableName]: items.map(item => ({
                PutRequest: {
                    Item: buildRequestPutItem(tableSchema, item).M
                }
            }))
        }
    };
}

/**
 * Build a request object that can be passed into `batchWriteItem`.
 * @param tableSchema
 * @param keyValues an array of the key values for each item to delete
 * @returns input for the `batchWriteItem` method
 */
export function buildBatchDeleteInput(tableSchema: TableSchema, keyValues: DynamoKey[] | DynamoKeyPair[]): aws.DynamoDB.Types.BatchWriteItemInput {
    checkSchema(tableSchema);
    checkSchemaKeysAgreement(tableSchema, keyValues);

    if (tableSchema.sortKeyType) {
        const keyPairs = keyValues as DynamoKeyPair[];
        return {
            RequestItems: {
                [tableSchema.tableName]: keyPairs.map(keyPair => ({
                    DeleteRequest: {
                        Key: {
                            [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, keyPair[0]),
                            [tableSchema.sortKeyField]: buildRequestPutItem(tableSchema, keyPair[1])
                        }
                    }
                }))
            }
        };
    } else {
        const flatKeys = keyValues as DynamoKey[];
        return {
            RequestItems: {
                [tableSchema.tableName]: flatKeys.map(key => ({
                    DeleteRequest: {
                        Key: {
                            [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, key)
                        }
                    }
                }))
            }
        };
    }
}

/**
 * Build a request object that can be passed into `batchGetItem`.
 * @param tableSchema
 * @param keyValues an array of the key values for each item to request
 * @returns input for the `batchGetItem` method
 */
export function buildBatchGetInput(tableSchema: TableSchema, keyValues: DynamoKey[] | DynamoKeyPair[]): aws.DynamoDB.Types.BatchGetItemInput {
    checkSchema(tableSchema);
    checkSchemaKeysAgreement(tableSchema, keyValues);

    if (tableSchema.sortKeyType) {
        const keyPairs = keyValues as DynamoKeyPair[];
        return {
            RequestItems: {
                [tableSchema.tableName]: {
                    Keys: keyPairs.map(keyPair => ({
                        [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, keyPair[0]),
                        [tableSchema.sortKeyField]: buildRequestPutItem(tableSchema, keyPair[1])
                    }))
                }
            }
        };
    } else {
        const flatKeys = keyValues as KeyType[];
        return {
            RequestItems: {
                [tableSchema.tableName]: {
                    Keys: flatKeys.map(key => ({
                        [tableSchema.primaryKeyField]: buildRequestPutItem(tableSchema, key)
                    }))
                }
            }
        };
    }
}

/**
 * Build a request object that can be passed into `createTable`.
 * ProvisionedThroughput takes on default values of 1 and 1 and
 * should probably be edited.
 * @param tableSchema
 * @returns input for the `createTable` method
 */
export function buildCreateTableInput(tableSchema: TableSchema): aws.DynamoDB.Types.CreateTableInput {
    checkSchema(tableSchema);

    const request = {
        AttributeDefinitions: [
            {
                AttributeName: tableSchema.primaryKeyField,
                AttributeType: jsTypeToDdbType(tableSchema.primaryKeyType)
            }
        ],
        KeySchema: [
            {
                AttributeName: tableSchema.primaryKeyField,
                KeyType: "HASH"
            }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1
        },
        TableName: tableSchema.tableName,
    };

    if (tableSchema.sortKeyField) {
        request.AttributeDefinitions.push({
            AttributeName: tableSchema.sortKeyField,
            AttributeType: jsTypeToDdbType(tableSchema.sortKeyType)
        });
        request.KeySchema.push({
            AttributeName: tableSchema.sortKeyField,
            KeyType: "RANGE"
        });
    }

    return request;
}

function jsTypeToDdbType(t: string): string {
    switch (t) {
        case "string":
            return "S";
        case "number":
            return "N";
    }
    throw new Error("Unhandled key type.");
}
