const assert = require('node:assert/strict');
const test = require('node:test');

const { charityRedFlowerDto } = require('../dist/services/activity-center');

function makeEntry({ flowStatus, donatedLove = '30', progressStatus = '0' }) {
    const now = Math.floor(Date.now() / 1000);
    return {
        activity: {
            activity_id: '2026090901',
            name: '公益小红花',
            begin_time: String(now - 60),
            end_time: String(now + 3600),
        },
        charity_red_flower: {
            love_item_id: '1040',
            donated_love: donatedLove,
            global_donated_love: '1',
            global_target_love: '100',
            flow_status: flowStatus,
            progress_rewards: [
                { target: '30', status: progressStatus, reward: { item_id: '80013', count: '1' } },
            ],
        },
    };
}

test('charity daily gift follows the red-flower flow status', () => {
    const notHarvested = charityRedFlowerDto(makeEntry({ flowStatus: '1' }));
    assert.equal(notHarvested.dailyGift.harvestedToday, false);
    assert.equal(notHarvested.dailyGift.claimed, false);
    assert.equal(notHarvested.actions.claimDailyGift.enabled, false);

    const harvested = charityRedFlowerDto(makeEntry({ flowStatus: '2' }));
    assert.equal(harvested.dailyGift.harvestedToday, true);
    assert.equal(harvested.dailyGift.claimed, false);
    assert.equal(harvested.actions.claimDailyGift.enabled, true);

    const claimed = charityRedFlowerDto(makeEntry({ flowStatus: '3' }));
    assert.equal(claimed.dailyGift.harvestedToday, true);
    assert.equal(claimed.dailyGift.claimed, true);
    assert.equal(claimed.actions.claimDailyGift.enabled, false);
});

test('charity progress status 0 is claimable and status 1 is already claimed', () => {
    const claimable = charityRedFlowerDto(makeEntry({ flowStatus: '2', progressStatus: '0' }));
    assert.equal(claimable.progressRewards[0].reached, true);
    assert.equal(claimable.progressRewards[0].claimable, true);

    const alreadyClaimed = charityRedFlowerDto(makeEntry({ flowStatus: '2', progressStatus: '1' }));
    assert.equal(alreadyClaimed.progressRewards[0].reached, true);
    assert.equal(alreadyClaimed.progressRewards[0].claimable, false);
});
