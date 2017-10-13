const SteamCommunity = require('steamcommunity');
const ReadLine = require('readline');
const async = require('async');

const community = new SteamCommunity();
const rl = ReadLine.createInterface({
    "input": process.stdin,
    "output": process.stdout
});

const walletInfo = {
    "wallet_fee_base": 0,
    "wallet_fee_percent": 0.05,
    "wallet_fee_minimum": 1,
    "wallet_publisher_fee_percent_default": 0.1,
    // USD = 1
    // GBP = 2
    // EUR = 3
    "wallet_currency": 3
};

rl.question("Username: ", function(accountName) {
    rl.question("Password: ", function(password) {
        doLogin(accountName, password);
    });
});

function doLogin(accountName, password, authCode, twoFactorCode, captcha) {
    community.login({
        "accountName": accountName,
        "password": password,
        "authCode": authCode,
        "twoFactorCode": twoFactorCode,
        "captcha": captcha
    }, function(err, sessionID, cookies, steamguard) {
        if(err) {
            if(err.message == 'SteamGuardMobile') {
                rl.question("Steam Authenticator Code: ", function(code) {
                    doLogin(accountName, password, null, code);
                });

                return;
            }

            if(err.message == 'SteamGuard') {
                console.log("An email has been sent to your address at " + err.emaildomain);
                rl.question("Steam Guard Code: ", function(code) {
                    doLogin(accountName, password, code);
                });

                return;
            }

            if(err.message == 'CAPTCHA') {
                console.log(err.captchaurl);
                rl.question("CAPTCHA: ", function(captchaInput) {
                    doLogin(accountName, password, authCode, twoFactorCode, captchaInput);
                });

                return;
            }

            console.log(err);
            process.exit();
            return;
        }

        console.log("Logged on!");
        console.log();

        community.getSteamUser(community.steamID, function(err, user) {
            if (err) {
                console.log(err);
                process.exit();
                return;
            }

            console.log("Looking up Steam inventory");

            // 753 = Steam
            // 6 = community items
            // true = only get tradeable items
            user.getInventoryContents(753, 6, true, function(err, inventory, currency, totalItems) {
                if (err) {
                    console.log(err);
                    process.exit();
                    return;
                }

                var lookupQueue = [];

                for (var i = 0; i < inventory.length; i++) {
                    var item = inventory[i];

                    if (item.marketable) {
                        queueMarketLookup(item, lookupQueue);
                    }
                }

                console.log("Looking up market info");

                async.series(lookupQueue, function(err, results) {
                    if (err && !err.message.startsWith("There are no listings")) {
                        console.log(err);
                        process.exit();
                        return;
                    }

                    results.filter(function(result) {
                        return result.price > 0;
                    });
                    
                    results.sort(function(a, b) {
                        return b.price - a.price;
                    });

                    var sellQueue = [];

                    for (var i = 0; i < results.length; i++) {
                        var result = results[i];
                        queueMarketSell(result.item, result.price, sellQueue);
                    }

                    console.log("Selling items");

                    async.series(sellQueue, function(err, results) {
                        if (err) {
                            console.log(err);
                            process.exit();
                            return;
                        }

                        console.log("Done placing sell offers!");
                    });
                });
            });
        });
    });
}

function queueMarketLookup(item, queue) {
    queue.push(function(callback) {
        console.log("Looking up market info for " + item.market_hash_name);

        community.getMarketItem(item.appid, item.market_hash_name, walletInfo['wallet_currency'], function(err, marketItem) {
            if (err) {
                return callback(err);
            }

            console.log("Looked up market info for " + item.market_hash_name);

            // Factor in sales fees so that we sell for exactly the highest buy order
            var fees = CalculateFeeAmount(marketItem.highestBuyOrder, walletInfo['wallet_publisher_fee_percent_default']);
            var price = fees.amount - fees.fees;

            callback(null, {
                "item": item,
                "price": price
            });
        });
    });
}

function queueMarketSell(item, price, queue) {
    queue.push(function(callback) {
        community.sellItem(item, item.amount, price, function(err, response, body) {
            if (err) {
                return callback(err);
            }

            console.log("Placed a sell order for " + item.amount + "x " + item.name + " at " + price + " cents each");
            callback(null);
        });
    });
}

// Code from https://github.com/tboothman/steam-market-seller:
// (which is originally from Steam's code)

function CalculateFeeAmount(amount, publisherFee) {
    publisherFee = (typeof publisherFee == 'undefined') ? 0 : publisherFee;
    // Since CalculateFeeAmount has a Math.floor, we could be off a cent or two. Let's check:
    var iterations = 0; // shouldn't be needed, but included to be sure nothing unforseen causes us to get stuck
    var nEstimatedAmountOfWalletFundsReceivedByOtherParty = parseInt((amount - parseInt(walletInfo['wallet_fee_base'])) / (parseFloat(walletInfo['wallet_fee_percent']) + parseFloat(publisherFee) + 1));
    var bEverUndershot = false;
    var fees = CalculateAmountToSendForDesiredReceivedAmount(nEstimatedAmountOfWalletFundsReceivedByOtherParty, publisherFee, walletInfo);
    while (fees.amount != amount && iterations < 10) {
        if (fees.amount > amount) {
            if (bEverUndershot) {
                fees = CalculateAmountToSendForDesiredReceivedAmount(nEstimatedAmountOfWalletFundsReceivedByOtherParty - 1, publisherFee, walletInfo);
                fees.steam_fee += (amount - fees.amount);
                fees.fees += (amount - fees.amount);
                fees.amount = amount;
                break;
            } else {
                nEstimatedAmountOfWalletFundsReceivedByOtherParty--;
            }
        } else {
            bEverUndershot = true;
            nEstimatedAmountOfWalletFundsReceivedByOtherParty++;
        }
        fees = CalculateAmountToSendForDesiredReceivedAmount(nEstimatedAmountOfWalletFundsReceivedByOtherParty, publisherFee, walletInfo);
        iterations++;
    }
    // fees.amount should equal the passed in amount
    return fees;
}

function CalculateAmountToSendForDesiredReceivedAmount(receivedAmount, publisherFee) {
    publisherFee = (typeof publisherFee == 'undefined') ? 0 : publisherFee;
    var nSteamFee = parseInt(Math.floor(Math.max(receivedAmount * parseFloat(walletInfo['wallet_fee_percent']), walletInfo['wallet_fee_minimum']) + parseInt(walletInfo['wallet_fee_base'])));
    var nPublisherFee = parseInt(Math.floor(publisherFee > 0 ? Math.max(receivedAmount * publisherFee, 1) : 0));
    var nAmountToSend = receivedAmount + nSteamFee + nPublisherFee;
    return {
        steam_fee: nSteamFee,
        publisher_fee: nPublisherFee,
        fees: nSteamFee + nPublisherFee,
        amount: parseInt(nAmountToSend)
    };
}
